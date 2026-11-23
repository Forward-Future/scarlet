import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod/v3";
import {
  DEFAULT_RESULT_CHARS,
  ScarletApiError,
  SheetRequest,
  type AgentCapabilities,
  type InspectionResult,
  type InspectionWindow,
  type ScarletClient,
  type Task,
  type TaskEvent,
} from "@scarlet/shared";
import { CutAssessment, type Author, type Change } from "@scarlet/timeline";
import { round3 } from "./analysis.js";
import {
  checkDialogueJoin,
  checkKeptWords,
  dialogueJoinChecker,
  dialogueJoinWords,
  quietFrameNote,
} from "./dialogue-join.js";
import { cutReading, joinPlays, NOTE_QUOTE_REACH, quotesAwayFromCut, timelineWordsNear } from "./dialogue-plan.js";
import { inspectDialogueSuggestion, MAX_WHOLE_PICTURE_SHEETS, type DialogueInspection } from "./dialogue-review.js";
import { assessedCuts, type StagedReview, type StagedReviewState } from "./dialogue-tools.js";
import { deliverWav, listening } from "./inspection-tools.js";
import { createAudioOption, crossfadeFrames, cutRow } from "./mcp-schema.js";
import type { MediaSession } from "./media-session.js";
import type { RevisionTracker, SessionErrorHelpers } from "./media-state.js";
import { resolveOutgoingPause } from "./outgoing-pause.js";
import type { PerceptionApi } from "./propose-pipeline.js";
import { Lanes, ReviewInspections, urgencyRank, type InspectionRequest } from "./review-prep.js";
import { describeError, json, noteEvidenceMiss, unavailable, type ToolRegistrar, type ToolResult } from "./tool-result.js";

/** Cuts dialogue_review_inspect returns in one result: each brings its words, levels and pictures. */
const INSPECT_AT_ONCE = 4;

export interface DialogueReviewToolsDeps {
  tool: ToolRegistrar;
  client: ScarletClient;
  projectId: string;
  taskId?: string;
  task?: Task;
  author: Author;
  caps: AgentCapabilities;
  session: MediaSession;
  errors: SessionErrorHelpers;
  revision: RevisionTracker;
  stagedState: StagedReviewState;
  localPausesMode(): Promise<boolean>;
  rendersDone(ids: string[]): Promise<boolean>;
  inspect(request: () => Promise<InspectionResult>, onReady?: (windows: InspectionWindow[]) => void, batchSignal?: AbortSignal): Promise<ToolResult>;
  postEvent(ev: Omit<TaskEvent, "taskId">): Promise<{ posted: boolean; error?: string }>;
  writeArtifact?: (path: string, data: Uint8Array) => Promise<string>;
  getPerception(): PerceptionApi;
}

export function registerDialogueReviewTools(deps: DialogueReviewToolsDeps) {
  const {
    tool, client, projectId, taskId, task, author, caps,
    session, errors, revision, stagedState, localPausesMode,
    rendersDone, inspect, postEvent, writeArtifact, getPerception,
  } = deps;
  const {
    getProject, peekTimeline, moveBase, transcriptWords, joinPages,
    measureTimeline, outgoingPausePages, planSources,
  } = session;
  const { without, unavailableOnce } = errors;
  const listen = listening(caps, !!writeArtifact);
  const defaultAudio = listen?.by === "file";
  const reviewPictures = caps.images;
  const audioOption = createAudioOption(!!listen, defaultAudio);

  /** Inspections that read every view of a cut, including a measured join (or a cut with no join). */
  const inspections = new Set<string>();
  // Source pictures decode from the original footage, about a second per sheet, and the engine
  // runs roughly one at a time. Two in flight keeps it busy without queueing far ahead of the agent.
  const lanes = new Lanes(2);
  async function readySheet(request: z.input<typeof SheetRequest>, priority: () => number) {
    return lanes.run(priority, async () => {
      const deadline = Date.now() + (priority() === urgencyRank("now") ? 20_000 : 60_000);
      let result = await client.contactSheet(projectId, request);
      while (result.state === "preparing") {
        if (Date.now() > deadline) throw new Error("Frames are still preparing. Inspect this cut again.");
        if (await rendersDone(result.renderIds)) result = await client.contactSheet(projectId, request);
        else await delay(300);
      }
      return result;
    });
  }

  async function computeInspection(change: Change, { index, audio, wholePicture }: InspectionRequest, priority: () => number): Promise<DialogueInspection> {
    const [{ review }, { media }] = await Promise.all([client.cutReview(change.id), client.media(projectId)]);
    if (!review) throw new Error("No reviewable cuts.");
    const edit = change.cutEdits?.find(e => e.index === index);
    if (edit && (!edit.previewVersion || change.cutChoices?.some(c => c.index === index && c.choice === "keep"))) return { content: json({ index, version: edit.version, range: edit.range,
      choice: "keep", alreadyRemoved: edit.range.start === edit.range.end }).content, receipt: { complete: false, picture: [] }, wholeSheets: 0 };
    const playback = edit?.previewVersion ? { original: await peekTimeline(edit.version), range: edit.range, previewVersion: edit.previewVersion } : undefined;
    const deliverAudio = listen && audio
      ? (wav: string, { mediaId, from, to }: { mediaId: string; from: number; to: number }) =>
        deliverWav(listen, wav, `listen/orig-${mediaId}-${from.toFixed(2)}-${to.toFixed(2)}.wav`,
          { kind: "original", mediaId, from, to, seconds: +(to - from).toFixed(2) },
          "Open this WAV file with your own file viewer to hear the original passage.", writeArtifact)
      : undefined;
    const result = await inspectDialogueSuggestion(client, change, review, media, index,
      { audio, images: reviewPictures, wholePicture, sheet: request => readySheet(request, priority), unavailable: unavailableOnce, playback, deliverAudio });
    const cut = review.cuts[index]!;
    const original = playback?.original ?? review.original;
    const range = playback?.range ?? cut.removed;
    // A fresh review session may have no cached scan from the pass that staged this cut.
    await measureTimeline(original, [range.start, range.end]).catch(without("failed to measure words beside the staged cut", undefined));
    const nearby = dialogueJoinWords(original, { media }, range, joinPages());
    if (nearby.start.length || nearby.end.length) result.content.push(...json({ nearbyWords: nearby }).content);
    const preview = playback ? await peekTimeline(playback.previewVersion) : review.proposed;
    const { repeatAtJoin, partialWordRepeat, pickupRepeats, unread } = await checkKeptWords(original, { media }, range, nearby, planSources.readKeptWords,
      playback ? undefined : review.cuts[index - 1]?.removed.end, playback ? undefined : review.cuts[index + 1]?.removed.start,
      { at: playback?.range.start ?? cut.at, preview: () => preview });
    if (repeatAtJoin || partialWordRepeat || pickupRepeats.length || unread.length) result.content.push({ type: "text", text: JSON.stringify({
      ...(partialWordRepeat && { partialWordRepeat }), ...(repeatAtJoin && { repeatAtJoin }), ...(pickupRepeats.length && { pickupRepeats }), ...(unread.length && { unreadJoinAudio: unread }),
    }) });
    // How the join sounds on the suggestion's version, measured the same way for every model.
    const { audits, noJoin } = await getPerception().auditAt(playback?.previewVersion ?? change.toVersion, playback?.range.start ?? cut.at).catch(err => {
      noteEvidenceMiss("join audit");
      result.content.push({ type: "text", text: JSON.stringify({ joinAudit: `unavailable: ${describeError(err)}` }) });
      return { audits: [], noJoin: undefined };
    });
    if (audits.length) result.content.push({ type: "text", text: JSON.stringify({ joinAudit: audits }) });
    if (noJoin) result.content.push({ type: "text", text: JSON.stringify({ joinAudit: noJoin }) });
    result.receipt.joinAudit = audits.length > 0 && audits.every(a => a.levels) ? audits.map(a => a.verdict).join("; ") : undefined;
    result.receipt.noJoin = noJoin;
    const removed = cut.removed;
    const repaired = !playback && change.cutReasons?.some(r => r.originalRange && r.start >= removed.start - .00001 && r.start < removed.end);
    if (repaired || (!playback && audio)) {
      let compared = false;
      if (audio || caps.images) {
        const comparison = await inspect(() => client.reviewCut(projectId, { changeId: change.id, index, edge: "start", handles: 1.5,
          includeAudio: audio }), windows => {
            const after = windows.find(w => w.id === change.toVersion && w.label === "After");
            compared = !!after;
            if (audio) result.receipt.heardJoin = !!after?.wav;
          });
        result.content.push(...comparison.content);
      }
      if (repaired && !compared) {
        result.receipt.complete = false;
        result.content.push({ type: "text", text: "A comparison preview for the narrowed join is unavailable (it is still preparing or frame tools are off). Inspecting this index again retries it." });
      }
    }
    return result;
  }

  const reviews = new ReviewInspections(computeInspection, { defaultAudio });
  /**
   * How many suggested cuts of a review have a recommendation, so the editor can see how far the checking has come.
   * `looked` also counts the cuts the agent has inspected but not saved yet: recommendations are often saved in one
   * batch at the end, and the count would sit at zero until then.
   */
  function cutProgress(changeId: string, checked: number, total: number, looked?: number) {
    return postEvent({ type: "log", text: "", data: { kind: "cut_progress", changeId, checked, total, ...(looked !== undefined && { looked }) } });
  }
  /** The cuts of each pending review the agent has looked at, by change and version. */
  const lookedAt = new Map<string, Set<number>>();

  async function prepareReview(changeId: string): Promise<StagedReview | undefined> {
    try {
      const [{ change }, { review }] = await Promise.all([client.changeRecord(changeId), client.cutReview(changeId)]);
      if (review && change.state === "ready") {
        reviews.ahead(change, 0, review.cuts.length);
        // A later part of a pass carries the earlier part's recommendations into its review.
        const assessed = assessedCuts(change);
        if (review.cuts.length) await cutProgress(changeId, assessed, review.cuts.length);
        return { changeId, total: review.cuts.length, unchecked: Math.max(0, review.cuts.length - assessed) };
      }
    } catch (err) {
      // The agent's own inspection prepares it instead.
      unavailable(`failed to prepare the review of ${changeId} ahead`, err);
    }
    return undefined;
  }

  tool("dialogue_review_inspect",
    "Inspect a staged dialogue cut in its original passage and preview. For each cut returns its first-pass reason, and held: what Scarlet measured when it held the cut, what its join plays and what keeping it plays. It also returns the words around it as [start, end, text, speaker or isolated input], original microphone levels (dBFS), voice activity, and timeline_join_audit's reading of the join or why the cut has none. The surviving speech is checked for a doubled word across the join or at the start or end of its kept take. partialWordRepeat identifies a cut-off word beside a whole occurrence in the saved audio, including faded handles. One call returns up to four consecutive cuts (count). Scarlet prepares the next ones while you read." +
    (reviewPictures ? " Includes synchronized screen and camera sheets and before/after frames for narrowed cuts. A longer removal shows an overview and windows for closer inspection. wholePicture returns activity sheets across all of them." : "") +
    (listen ? (listen.by === "file"
      ? " Writes WAV files of the original passage and the rendered Before/After join to your task folder. Open the After WAV with your file viewer and hear how the cut plays before you decide: levels can't tell how a same-word join or a tight cut sounds."
      : " Pass includeAudio: true to attach WAV audio of the original passage and the rendered join (especially for a same-word join or tight cut where levels alone can't tell).") : "") +
    " nearbyWords gives the words at both edges in TIMELINE seconds on the inspected original. Use those times in dialogue_revise_cut to move a splice, or save a recommendation for the current range with dialogue_review_save. If later edits conflict with the cut being revised, inspecting it returns its current passage and words for dialogue_revise_cut.",
    { changeId: z.string(), index: z.number().int().nonnegative(),
      // A larger count is not refused: a pass asked for all 14 of its cuts and lost a turn to the limit (2026-11-15).
      count: z.number().int().min(1).max(500).default(1).describe(`Inspect this many consecutive suggestions, starting at index. One call returns ${INSPECT_AT_ONCE} at most and names the index to continue from.`),
      ...(reviewPictures && { wholePicture: z.boolean().default(false).describe("For one longer removal: activity sheets across its whole removed picture in one result.") }),
      ...audioOption(listen?.by === "file" ? "Write WAV files of the original passage and rendered join to your task folder to open with your file viewer and hear" : "Attach WAV of the original passage and of the join") },
    async ({ changeId, index, count, wholePicture: requestedPicture, includeAudio }) => {
      const wholePicture = reviewPictures && requestedPicture === true;
      if (revision.cutConflict && revision.conflictAt(changeId, index)) {
        const { version, range } = revision.cutConflict;
        const location = json({ index, currentVersion: version, range,
          next: range ? "Use this version for a revision of the current footage." : "The original footage has no unique placement. Inspect current takes with timeline_transcript and timeline_at." });
        if (range) {
          const words = await getPerception().readTranscript({ version, from: Math.max(0, range.start - 2), to: range.end + 2, detail: "words" });
          location.content.push(...words.content);
        }
        return location;
      }
      const [{ change }, { review }] = await Promise.all([client.changeRecord(changeId), client.cutReview(changeId)]);
      const pending = change.state === "ready" || (change.state === "revising" && change.id === revision.stagedCut?.changeId);
      if (change.projectId !== projectId) throw new Error(`Change ${changeId} belongs to another project.`);
      if (change.intent !== "suggestion" || !pending) {
        throw new Error(`Change ${changeId} is ${change.state}${change.intent ? ` (${change.intent})` : ""}. dialogue_review_inspect reads a pending dialogue suggestion; use change_list to find one.`);
      }
      if (!review?.cuts.length) throw new Error(`Change ${changeId} has no individual cuts to inspect; it replaces the whole timeline.`);
      if (index >= review.cuts.length) throw new Error(`Change ${changeId} has ${review.cuts.length} cuts (index 0–${review.cuts.length - 1}).`);
      const audio = !!listen && (includeAudio ?? defaultAudio);
      const end = wholePicture ? index + 1 : Math.min(review.cuts.length, index + Math.min(count, INSPECT_AT_ONCE));
      reviews.ahead(change, end, review.cuts.length);
      const indexes = Array.from({ length: end - index }, (_, k) => index + k);
      const jobs = indexes.map(i => {
        const req: InspectionRequest = { index: i, audio, wholePicture };
        return { i, req, job: reviews.prepare(change, req, "now") };
      });
      const maxChars = caps.resultChars ?? DEFAULT_RESULT_CHARS;
      const asked = Math.min(review.cuts.length, index + count);
      const reserve = !wholePicture && asked > index + 1 ? 200 : 0;
      const textLen = (parts: ToolResult["content"]) =>
        parts.reduce((n, part) => n + (part.type === "text" ? part.text.length : 0), 0);
      const content: ToolResult["content"] = [];
      const delivered: number[] = [];
      let textChars = 0;
      for (const { i, req, job } of jobs) {
        const result = await job;
        // An honest receipt: every view arrived, the join was measured or there is none, and a hearing model got the join audio.
        const { receipt } = result;
        const inspected = receipt.complete && !!(receipt.joinAudit || receipt.noJoin) && receipt.heardJoin !== false;
        const windows = result.receipt.picture;
        const whole = result.wholeSheets <= MAX_WHOLE_PICTURE_SHEETS;
        const footer: ToolResult["content"][number] = { type: "text", text: JSON.stringify({ complete: inspected, additionalActivityWindows: windows,
          ...(windows.length ? { closerLook: whole ? `dialogue_review_inspect with index ${i} and wholePicture true returns them in one result.`
            : `This removal needs ${result.wholeSheets} activity sheets. Use frame_contact_sheet_batch for a closer look.` } : {}) }) };
        const cutChars = textLen(result.content) + footer.text.length;
        // Always deliver at least one cut; leave deferred cuts cached warm in ReviewInspections for the next call.
        if (delivered.length > 0 && textChars + cutChars + reserve > maxChars) break;
        reviews.consume(change, req, job);
        const edit = change.cutEdits?.find(e => e.index === i);
        if (edit && inspected) revision.readPassage(edit.version, edit.range);
        const key = JSON.stringify([changeId, change.fromVersion, change.toVersion, i]);
        if (inspected) inspections.add(key); else inspections.delete(key);
        content.push(...result.content, footer);
        textChars += cutChars;
        delivered.push(i);
        // If the agent looks closer, the whole picture is ready. It waits behind the cuts the agent reads next.
        if (windows.length && whole && !wholePicture) void reviews.prepare(change, { index: i, audio, wholePicture: true }, "later").catch(() => undefined);
      }
      const deliveredEnd = index + delivered.length;
      const version = JSON.stringify([changeId, change.fromVersion, change.toVersion]);
      const seen = lookedAt.get(version) ?? new Set<number>();
      lookedAt.set(version, seen);
      for (const i of delivered) seen.add(i);
      // Cuts with a carried recommendation count too, so the figure never drops below what is saved.
      const assessed = change.cutAssessments?.filter(a => !a.provisional).map(a => a.index) ?? [];
      await cutProgress(changeId, assessed.length, review.cuts.length, new Set([...assessed, ...seen]).size);
      if (!wholePicture && deliveredEnd < asked) content.push({ type: "text", text: JSON.stringify({ returned: [index, deliveredEnd - 1],
        next: `Continue with index ${deliveredEnd} (count ${asked - deliveredEnd}) for cuts ${deliveredEnd}–${asked - 1}.` }) });
      return { content };
    });

  tool("dialogue_review_save", "Record your cut, keep or ask recommendation on a pending suggestion. An ask's reason appears on its card, where it explains why you recommend it and what to listen or look for. Cuts that would wait under the same reason are refused, and so is an ask whose reason quotes words its cut neither removes nor plays within 3 s of it: the refusal says what the cut removes and what its join plays. An ask or cut on a staged cut whose edge is inside a word that sounds there is refused with what was measured: move it with dialogue_revise_cut and record it as moved, or keep it. A cut on a same-word join, which Scarlet placed by matching the two deliveries but can't hear, is saved, and sameWordJoins returns what was measured there. Use the exact change versions, chronological cut index and original timeline range. Saving an ask gives the passage and its note to the editor. A cut goes into the video when the request finishes, or with the editor's last call when some wait for them, so it is not removed again with another tool. A keep leaves the footage in the video and the editor is never shown that cut; a cut whose range is wrong can be moved with dialogue_revise_cut before it is recorded. Later recommendations preserve that call (heldCalls, or heldRevised after a requested revision). To tell the editor something new about a call still waiting on them, such as a join that clips a word, save it as an ask with amend:true and the new reason: its card shows that note, and its number, footage and verdict stay. The inspected flag reports whether this session completed an inspection of that exact cut, including its measured join (or a cut with no join).",
    { changeId: z.string(), fromVersion: z.string(), toVersion: z.string(), assessments: z.array(CutAssessment.omit({ inspected: true, revised: true, askOrder: true, provisional: true }).extend({
      summary: CutAssessment.shape.summary.describe(`${cutRow} Supply it alongside the reason shown on the card.`),
      amend: z.boolean().optional().describe("Replace the note of a call that already waits on the editor."),
    })).min(1).max(500) },
    async ({ changeId, fromVersion, toVersion, assessments }) => {
      const { change } = await client.changeRecord(changeId);
      if (await localPausesMode() && ![taskId, task?.resumeRootId].some(id => id && id === change.taskId) &&
          !task?.changeIds.includes(changeId)) {
        const prior = change.taskId && (await client.task(change.taskId, "none")).task;
        if (!prior || (prior.resumeRootId ?? prior.id) !== (task?.resumeRootId ?? taskId))
          throw new Error("Choose a staged pause from this request.");
      }
      if (change.projectId !== projectId) throw new Error(`Change ${changeId} belongs to another project.`);
      // A call's note is the editor's only account of it, so it is about that cut: a note that quotes words the cut
      // neither removes nor plays beside goes back with what the cut does (quotesAwayFromCut).
      const asks = assessments.filter(a => a.verdict === "ask" && a.reason && quotesAwayFromCut(a.reason, [], a).length);
      if (asks.length) {
        const [tl, { project }] = await Promise.all([peekTimeline(fromVersion), getProject()]);
        const words = (mediaId: string) => transcriptWords(mediaId, false).catch(() => null);
        const away = (await Promise.all(asks.map(async a => {
          const near = await timelineWordsNear(tl, project, a, words, NOTE_QUOTE_REACH + 15);
          const quotes = quotesAwayFromCut(a.reason, near, a);
          if (!quotes.length) return undefined;
          const removed = near.filter(h => h.at > a.start && h.at < a.end).map(h => h.text).join(" ");
          return `Cut ${a.index}: the note quotes ${quotes.map(q => `“${q}”`).join(" and ")}, which this cut neither removes nor plays within ${NOTE_QUOTE_REACH} s of it. ` +
            `It removes “${removed}” and plays “${await joinPlays(tl, project, a, words)}”.`;
        }))).filter(line => line !== undefined);
        if (away.length) throw new Error(`${away.join(" ")} Nothing was saved. Write each note about its own cut, or check that the cut is the one you meant.`);
      }
      // A clipped word is not a creative call, and cutting there plays it clipped: a staged cut whose edge is inside a word
      // that sounds there is moved or kept, never asked about or cut as placed (his rule, 2026-11-16).
      const toCheck = assessments.filter(a => a.verdict === "ask" || a.verdict === "cut");
      // A cut recorded on a same-word join, with what was measured there. Such a cut used to be refused, the join the
      // editor's to hear (his rule, 2026-11-17). Since 2026-11-21 the model decides, and the default is in the skill;
      // the measurement goes back with the save.
      let sameWordJoins: Array<{ index: number; reason: string }> = [];
      if (toCheck.length) {
        const [tl, { project }] = await Promise.all([peekTimeline(fromVersion), getProject()]);
        await measureTimeline(tl, toCheck.flatMap(a => [a.start, a.end])).catch(() => undefined);
        const check = dialogueJoinChecker(tl, project, joinPages());
        const joins = toCheck.map(a => ({ a, join: check({ start: a.start, end: a.end }) }));
        const clipped = joins.flatMap(({ a, join }) => join.inWord?.length ? [`Cut ${a.index} (${a.verdict}): ${join.reason}`] : []);
        if (clipped.length) throw new Error(`${clipped.join(" ")} Nothing was saved. A cut with an edge inside a word that sounds there can't be asked about or made as placed. Move it with dialogue_revise_cut, onto the quiet or low point named or to the boundary of the words, then record cut or ask on it as moved; or record keep, which leaves its words playing without the editor hearing this passage.`);
        sameWordJoins = joins.flatMap(({ a, join }) => join.sameWord && a.verdict === "cut" ? [{ index: a.index, reason: join.reason ?? "" }] : []);
      }
      const recorded = assessments.map(a => ({ ...a,
        inspected: inspections.has(JSON.stringify([changeId, fromVersion, toVersion, a.index])) }));
      const result = await client.assessCuts(changeId, fromVersion, toVersion, recorded);
      await postEvent({ type: "log", text: `Saved recommendations for ${result.assessed} of ${result.total} suggested cuts.`,
        data: { kind: "editor_progress", reviewCounter: `cuts/${changeId}/${toVersion}`, count: result.assessed } });
      await cutProgress(changeId, result.assessed, result.total);
      if (stagedState.stageWithoutAppliedCuts === changeId && result.assessed > assessedCuts(change)) stagedState.stageWithoutAppliedCuts = undefined;
      if ((await stagedState.stagedReview)?.changeId === changeId)
        stagedState.stagedReview = Promise.resolve({ changeId, total: result.total, unchecked: Math.max(0, result.total - result.assessed) });
      // What happens to a cut recorded as cut is not in its name: passes went on to remove such cuts a second time with
      // timeline_propose, three refused calls a pass, and one resubmitted held cuts in seconds to get them in (2026-11-15).
      const settled = result.assessed >= result.total && !result.needsDecision;
      return json({ ...result, ...(sameWordJoins.length && { sameWordJoins }), ...(settled && { next: "Every staged cut has your recommendation and none waits for the editor. "
        + "The ones recorded as cut go into the video when this request finishes, and the keeps stay. Leave their footage as it is: removing it with another tool is refused." }) });
    });

  type MeasuredPause = Exclude<ReturnType<typeof resolveOutgoingPause>, { status: "unavailable" }>;
  async function savedPause(pause: MeasuredPause, preview: string, at: number) {
    const outgoingPause = { word: pause.word.text, beforeSeconds: round3(pause.beforeSeconds) };
    try {
      const { audits, noJoin } = await getPerception().auditAt(preview, at);
      const reading = audits.find(a => a.out.mediaId === pause.word.mediaId && a.out.lastWord === pause.word.text &&
        a.out.lastWordEnd !== undefined && Math.abs(a.out.lastWordEnd - pause.word.sourceEnd) < .002);
      if (reading?.out.wordEndToJoin !== undefined)
        return { outgoingPause: { ...outgoingPause, remainingSeconds: reading.out.wordEndToJoin }, joinAudit: audits };
      return { outgoingPause, joinAudit: audits, verification: noJoin ?? "The preview could not verify the distance from this word to the join." };
    } catch (err) {
      noteEvidenceMiss("preview measurement");
      return { outgoingPause, verification: `Preview measurement unavailable: ${describeError(err)}` };
    }
  }

  tool("dialogue_revise_cut", "Move a staged dialogue cut. Once a call is with the editor, its range can change only on their request about that cut, and the revised cut goes back to them as a call with `reason` as its note: a doubt for them to listen for goes there, and needs no flag or review save. To trim the pause before a cut, give pauseAfterWord in seconds (0 for the end of the last kept word) instead of start and end. Scarlet locates that word, preserves the incoming edge and measures the word-to-join distance on the saved preview (outgoingPause.remainingSeconds): give the editor that measured time. For other moves give the full new range in TIMELINE seconds on the pass's fromVersion. It may extend past the old edges but must stay clear of neighboring staged cuts. If newer edits affect this passage, Scarlet returns the current version and its location when known. Inspect the current words with timeline_transcript or measure the new edges with dialogue_check_join, then pass that exact version and range to save on the current footage. If the requested result is clear, finish the revision. If it depends on which take the editor wants, task_question can ask that choice. To keep the current footage for the selected call, pass keep:true; when the passage has no current location, use its original range without version. The other cuts and decisions carry over. Measured nearby silence can adjust an edge. Write the reason for the editor in one short sentence. To move several cuts of one pass, list them as cuts in one call. Each moved cut's result has nearbyWords: the words either side of its saved edges as [timeline start, timeline end, text] on the version its times are on, the same reading dialogue_check_join returns, and removes and plays: the words it takes out and the join as the viewer hears it.",
    { changeId: z.string(), version: z.string().min(1).optional().describe("Exact version of an inspected current passage; omit for times on the pass's fromVersion"),
      index: z.number().int().nonnegative().optional(), start: z.number().finite().nonnegative().optional(), end: z.number().finite().nonnegative().optional(),
      crossfadeFrames: crossfadeFrames.describe("Total audio-only overlap in project frames for these revised cuts. Omit to keep the existing transition."),
      pauseAfterWord: z.number().finite().nonnegative().optional().describe("Timeline seconds to leave between the last complete word and the start of this cut. Use 0 to trim up to the word."),
      keep: z.literal(true).optional().describe("Keep the current footage for the staged cut this request is about"),
      reason: z.string().trim().min(1).max(800).optional(),
      summary: CutAssessment.shape.summary.describe(`For the revised cut. ${cutRow}`),
      cuts: z.array(z.object({ index: z.number().int().nonnegative(), start: z.number().finite().nonnegative(), end: z.number().finite().nonnegative(), keep: z.literal(true).optional(),
        reason: z.string().trim().min(1).max(800), summary: CutAssessment.shape.summary })).min(1).max(50).optional().describe("Several cuts of this pass to move in one call, instead of the fields for one cut"),
      noteIds: z.array(z.string()).optional() },
    async ({ changeId, version, index, start, end, pauseAfterWord, keep, reason, summary, cuts, noteIds, crossfadeFrames }) => {
      const one = index !== undefined || start !== undefined || end !== undefined || reason !== undefined || summary !== undefined || keep !== undefined || pauseAfterWord !== undefined;
      if (one === !!cuts) throw new Error("Give either index, start, end and reason for one cut, or a cuts list.");
      if (pauseAfterWord !== undefined && (start !== undefined || end !== undefined || keep)) throw new Error("Give pauseAfterWord on its own with index and reason.");
      if (!cuts && (index === undefined || !reason || (pauseAfterWord === undefined && (start === undefined || end === undefined))))
        throw new Error("A move needs index, reason and either start/end or pauseAfterWord.");
      const indices = cuts ? cuts.map(m => m.index) : [index!];
      if (new Set(indices).size !== indices.length) throw new Error("Each cut can be moved once per call.");
      const selected = await revision.useStagedCut();
      if (!selected && await localPausesMode()) throw new Error("Only the staged pause selected by the editor can be revised here.");
      if (selected && (indices.length !== 1 || changeId === revision.stagedCut?.changeId && revision.stagedCut.index !== indices[0]))
        throw new Error("Choose only the staged cut selected for this request.");
      // Carried versions can renumber a slot. The engine follows the selected passage through its replacement history.
      const { change } = await client.changeRecord(changeId);
      if (change.projectId !== projectId || change.intent !== "suggestion") throw new Error("Choose a pending dialogue pass in this project.");
      const canKeep = (idx: number) => selected && revision.stagedCut && (
        revision.stagedCut.index === idx && (revision.stagedCut.changeId === changeId || !!taskId && change.taskId === taskId) ||
        revision.namedConflict?.changeId === revision.stagedCut.changeId && revision.namedConflict.index === revision.stagedCut.index && revision.conflictAt(changeId, idx));
      if (cuts ? cuts.some(m => m.keep && !canKeep(m.index)) : keep && !canKeep(index!)) {
        throw new Error("Keep applies only to the staged cut selected for this request.");
      }
      if (version === "head") throw new Error("Give the exact version you inspected so your decision stays with that footage.");
      const project = (await getProject()).project;
      let pause: MeasuredPause | undefined;
      if (pauseAfterWord !== undefined && index !== undefined) {
        const { review } = await client.cutReview(changeId);
        const cut = review?.cuts[index];
        if (!cut || review?.firstCut) throw new Error("Choose an individual staged cut to tighten.");
        const edit = change.cutEdits?.find(e => e.index === index);
        const conflict = revision.conflictAt(changeId, index) ? revision.cutConflict : undefined;
        const range = conflict ? conflict.range : edit?.range ?? cut.removed;
        const on = conflict?.version ?? edit?.version ?? change.fromVersion;
        if (!range || range.start >= range.end || (edit && !edit.previewVersion)) throw new Error("This cut has no current removal to tighten.");
        if (version && version !== on) throw new Error(`This cut is on ${on}. Measure its pause there.`);
        const source = await peekTimeline(on);
        const measured = resolveOutgoingPause(source, project, range, await outgoingPausePages(source, project, range.start), pauseAfterWord);
        if (measured.status === "unavailable") throw new Error(measured.reason);
        if (measured.status === "already-at-target" && !conflict && crossfadeFrames === undefined) {
          const check = await savedPause(measured, edit?.previewVersion ?? change.toVersion, edit?.range.start ?? cut.at);
          return json({ changeId, index, ...range, unchanged: true, ...check });
        }
        pause = measured;
        start = measured.start;
        end = measured.end;
        version = on;
        revision.readPassage(on, { start, end }, true);
      }
      const moves = cuts ?? [{ index: index!, start: start!, end: end!, reason: reason!, summary, keep }];
      const tl = await peekTimeline(version ?? change.fromVersion);
      // A request about one staged cut seldom reads the recording in pages, so the sound beside each new edge is measured
      // here, as dialogue_check_join does. Without it no edge could be judged, and none snapped.
      if (!pause) await measureTimeline(tl, moves.flatMap(m => m.keep ? [] : [m.start, m.end]));
      // Revisions keep their slots. When a later part has carried the pass, the engine translates every
      // remaining request from its original pass, where the agent measured its ranges and indices.
      let current = change.id, revised: Awaited<ReturnType<typeof client.reviseStagedCut>>["change"] | undefined;
      // The pass Scarlet made the first move on, when a revision had replaced the one named.
      let replaced: string | undefined;
      let carried = false;
      const results: Array<Record<string, unknown>> = [];
      for (const move of moves) {
        // A rollback can make the original version the current one again after this cut changed.
        const priorEdit = change.cutEdits?.some(e => e.index === move.index);
        if (version && (version !== change.fromVersion || revision.cutConflict || priorEdit || carried || change.replacedBy) &&
          !revision.cutInspections.some(({ version: read, range, edges }) => read === version &&
          (edges ? Math.abs(range.start - move.start) < .001 && Math.abs(range.end - move.end) < .001
            : range.start <= move.start + 1e-6 && range.end >= move.end - 1e-6))) {
          revision.revisionVersions.add(version);
          const error = `Inspect the words, picture or proposed edges on version ${version} with timeline_transcript, frame_contact_sheet or dialogue_check_join before saving these times.`;
          if (!cuts) throw new Error(error);
          results.push({ index: move.index, error });
          continue;
        }
        const join = move.keep || pause ? undefined : checkDialogueJoin(tl, project, move, joinPages());
        // Snapping keeps every word, and so does an edge in quiet moved onto a quiet frame (`unchanged`), as dialogue_apply_cuts
        // saves it. Otherwise the requested edges stand; the editor auditions the cut before approving it.
        const range = join?.status === "snapped" || join?.status === "unchanged" ? { start: join.start, end: join.end } : { start: move.start, end: move.end };
        const onQuietFrame = join?.status === "unchanged" ? quietFrameNote(move, range) : undefined;
        let savedIndex = move.index;
        try {
          const saved = await client.reviseStagedCut(current, move.index, { ...range, version, crossfadeFrames, ...(pause && { requireCurrentCut: true }), keep: move.keep, reason: move.reason, summary: move.summary, taskId,
            author, noteIds: noteIds ?? task?.context.noteIds });
          revised = saved.change;
          savedIndex = saved.index ?? move.index;
          carried ||= !!saved.carried;
          replaced ??= saved.replaced;
        } catch (err) {
          if (pause && err instanceof ScarletApiError && err.code === "cut_review_moved")
            return { ...json({ error: err.message, currentCut: err.details }), isError: true };
          if (err instanceof ScarletApiError && err.code === "cut_review_stale") {
            const location = z.object({ currentVersion: z.string(), changeId: z.string().optional(), index: z.number().int().nonnegative().optional(),
              range: z.object({ start: z.number(), end: z.number() }).optional() }).safeParse(err.details);
            if (location.success) {
              const { currentVersion, range } = location.data;
              revision.namedConflict = { changeId, index: move.index };
              revision.cutConflict = { changeId: location.data.changeId ?? changeId, index: location.data.index ?? move.index, version: currentVersion, range };
              const failure = { index: move.index, error: err.message, currentVersion, range,
                next: range ? "Inspect the current passage with dialogue_review_inspect, frame_contact_sheet or dialogue_check_join, then save the intended range with this version. Ask only if the editor's preference would change the result."
                  : "Scarlet could not identify a unique current location. Inspect the current transcript and the source placements with timeline_at. If a creative choice remains, ask about the takes." };
              if (!cuts) return { ...json(failure), isError: true };
              results.push(failure);
              continue;
            }
          }
          // One cut that can't move doesn't undo the ones before it or stop the ones after.
          if (!cuts) throw err;
          results.push({ index: move.index, error: describeError(err) });
          continue;
        }
        current = carried ? changeId : revised.id;
        if (revision.conflictAt(changeId, move.index)) revision.cutConflict = undefined;
        const settled = !join || join.status === "unchanged" || join.status === "snapped" || !!join.sameWord;
        // The words either side of the new join, so the move can be judged from its result without reading the passage again.
        const nearbyWords = move.keep ? undefined : dialogueJoinWords(tl, project, range, joinPages());
        const heard = move.keep ? undefined : await cutReading(tl, project, range, mediaId => transcriptWords(mediaId, false).catch(() => null));
        results.push({ index: savedIndex, ...(savedIndex !== move.index && { requestedIndex: move.index }), ...range, ...(move.keep && { choice: "keep" }), ...heard, audio: join?.status === "unchanged" ? onQuietFrame : join?.reason,
          ...(join?.sameWordJoin && { sameWordJoin: join.sameWordJoin }),
          ...(nearbyWords && (nearbyWords.start.length || nearbyWords.end.length) && { nearbyWords }),
          next: settled ? undefined : "An edge isn't on measured silence. Check it with dialogue_check_join and call again with a quiet edge if one exists. The latest call replaces this one." });
      }
      if (!revised) return json({ changeId, moved: results });
      moveBase(undefined);
      await postEvent({ type: "change", text: revised.description, data: { changeId: revised.id, toVersion: revised.toVersion, state: revised.state } });
      // The engine puts each cut on whole frames. Report the ranges it saved, which are the ones a recommendation names.
      const edits = new Map(revised.cutEdits?.map(edit => [edit.index, edit]));
      const needsOriginal = results.some(r => typeof r.index === "number" && !r.error && !r.choice && !edits.has(r.index));
      const stored = needsOriginal ? (await client.cutReview(revised.id).catch(without(`failed to read the ranges saved for ${revised.id}`, undefined)))?.review?.cuts : undefined;
      for (const result of results) {
        if (typeof result.index !== "number" || result.error) continue;
        const currentEdit = edits.get(result.index);
        if (currentEdit) {
          Object.assign(result, currentEdit.range, { version: currentEdit.version, previewVersion: currentEdit.previewVersion });
          if (currentEdit.range.start === currentEdit.range.end && !result.choice) {
            Object.assign(result, { alreadyRemoved: true, choice: "keep" });
            delete result.audio;
            delete result.next;
          }
        } else if (result.choice === "keep") {
          delete result.start;
          delete result.end;
        } else if (stored?.[result.index]?.removed) Object.assign(result, stored[result.index]!.removed);
        if (pause && !result.choice) {
          const at = currentEdit?.range.start ?? stored?.[result.index]?.at;
          Object.assign(result, at === undefined ? { verification: "The saved preview's join could not be located." }
            : await savedPause(pause, currentEdit?.previewVersion ?? revised.toVersion, at));
        }
      }
      const pass = { changeId: revised.id, state: revised.state, fromVersion: revised.fromVersion, toVersion: revised.toVersion,
        ...(replaced && { movedOn: replaced, note: `A revision had replaced ${changeId} with ${replaced} since this was asked. Scarlet made this move on ${replaced}, so the pass keeps that revision.` }) };
      if (!cuts) return json({ ...pass, ...results[0] });
      const maxChars = caps.resultChars ?? DEFAULT_RESULT_CHARS;
      const omitted: number[] = [];
      const build = () => ({ ...pass, moved: results, ...(omitted.length && { nearbyWordsOmitted: omitted.slice().sort((a, b) => a - b) }) });
      if (JSON.stringify(build()).length > maxChars) {
        // Shed nearbyWords on settled moves first (from the end), then unsettled moves if still over budget.
        for (const settledOnly of [true, false]) {
          for (let i = results.length - 1; i >= 0 && JSON.stringify(build()).length > maxChars; i--) {
            const entry = results[i]!;
            if (!entry.nearbyWords || (settledOnly && (entry.next || entry.error))) continue;
            delete entry.nearbyWords;
            if (typeof entry.index === "number") omitted.push(entry.index);
          }
        }
      }
      return json(build());
    });

  return {
    prepareReview,
    close: () => reviews.close(),
  };
}
