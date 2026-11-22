import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  cutAnchorOn,
  flattenWords,
  ScarletApiError,
  type ProjectDetail,
  type ScarletClient,
  type Task,
  type TaskEvent,
  type WaveformResponse,
} from "@scarlet/shared";
import {
  clipDuration,
  sourceToTimeline as clipSourceToTimeline,
  timelineToSource,
  type TimeRange,
  type Timeline,
  type Transcript,
  type TranscriptWord,
} from "@scarlet/timeline";
import { dbfs, isTag } from "./analysis.js";
import type { DialogueEvidence } from "./dialogue-decisions.js";
import {
  clipEdgeSound,
  dialogueAudioStream,
  dialogueClips,
  joinEvidence,
  NoCachedSpeech,
  type JoinPage,
} from "./dialogue-join.js";
import { audibleSourcePoints, type DialoguePlanSources } from "./dialogue-plan.js";
import { gapSound, QUIET_PHRASE_CONTEXT, quietPhrases, roomRms, speakingLevel, type GapLevels, type GapSound, type QuietPhrase } from "./gap-sound.js";
import { levelPoints, transcriptionNote, type SessionErrorHelpers } from "./media-state.js";
import { Lanes } from "./review-prep.js";
import { newClipEdges } from "./timeline-validation.js";
import { describeError, MediaPreparing, raceTimeout } from "./tool-result.js";
import { wordDigest } from "./transcript-digest.js";

/**
 * How long a cut or an edge check waits for word alignment to reach it before asking to be called again. Alignment
 * runs ahead of the pages a pass reads, so this covers the turn or two it can be behind.
 */
const EDGE_WAIT_MS = 40_000;
const CHUNK = 300;
/** The most words and gaps the engine reads in one other-input request (`/media/:id/other-input`). */
const OTHER_INPUT_WORDS = 5000, OTHER_INPUT_GAPS = 2000;

export const EDGES_IN_SOUND = "Nothing was saved. Move each edge to a clean second given (source seconds), or onto quiet dialogue_check_join measures, or remove dialogue with dialogue_apply_cuts, where a word reference puts each edge in the recording's silence.";

export type WordSnapshot = { print: string; texts: readonly string[]; searchId?: string };

export interface MediaSessionDeps {
  client: ScarletClient;
  projectId: string;
  taskId?: string;
  taskStartedAt?: string;
  task?: Task;
  alignmentWaitMs?: number;
  evidence: DialogueEvidence;
  errors: SessionErrorHelpers;
  postEvent(ev: Omit<TaskEvent, "taskId">): Promise<{ posted: boolean; error?: string }>;
}

export function createMediaSession(deps: MediaSessionDeps) {
  const { client, projectId, taskId, taskStartedAt, task, evidence, errors, postEvent } = deps;
  const { unavailableOnce, withoutOnce } = errors;

  const getProject = () => client.projectInfo(projectId);
  const getHeader = () => client.projectHeader(projectId);

  let localRange = task?.context.dialogueRange;

  /**
   * The version this agent last looked at. Edits are proposed against it, so
   * if someone approves another change while the agent works, Scarlet can
   * still merge these edits correctly instead of misplacing them.
   */
  let lastTimeline: Timeline | undefined;
  /**
   * Only the agent's own looks move it: timeline_get, timeline_at and project_get, as `fromVersion` says. Reads sent
   * together can answer in any order, so the one asked for last holds, and a save that moves the video on clears it.
   */
  let baseAsked = 0, baseHeld = 0;
  const nextBaseAsk = () => ++baseAsked;
  function moveBase(timeline: Timeline | null | undefined, asked = ++baseAsked) {
    if (asked < baseHeld) return;
    baseHeld = asked;
    lastTimeline = timeline && timeline.version !== "draft" ? timeline : undefined;
  }

  /** The agent's own read of a version: edits it proposes next are based on it. */
  async function getTimeline(version?: string): Promise<Timeline> {
    if (lastTimeline && version === lastTimeline.version && version !== "head") return lastTimeline;
    const asked = ++baseAsked;
    const { timeline } = await client.timeline(projectId, version ?? "head");
    moveBase(timeline, asked);
    return timeline;
  }

  /**
   * A version read for a measurement rather than by the agent: the earlier side of a diff, a change's two versions,
   * a staged cut's join, a version a check or a save is given. It leaves the version edits are proposed against where
   * the agent's own reads put it.
   * A saved version never changes, so the last few are kept.
   */
  const measuredVersions = new Map<string, Timeline>();
  async function peekTimeline(version: string): Promise<Timeline> {
    if (lastTimeline && version === lastTimeline.version && version !== "head") return lastTimeline;
    const kept = measuredVersions.get(version);
    if (kept) return kept;
    const { timeline } = await client.timeline(projectId, version);
    if (timeline.version === version && version !== "draft") {
      if (measuredVersions.size >= 4) measuredVersions.delete(measuredVersions.keys().next().value!);
      measuredVersions.set(version, timeline);
    }
    return timeline;
  }

  async function cutAnchor(timeline: Timeline) {
    const anchor = { ...task?.context, dialogueRange: localRange };
    const version = localRange?.version ?? anchor.version;
    return cutAnchorOn(anchor, timeline, version && version !== "head" && version !== timeline.version ? await peekTimeline(version) : undefined);
  }

  /** The version an edit goes on when none is given: the one the agent last read, or else head. */
  async function baseTimeline(): Promise<Timeline> {
    return lastTimeline ?? await peekTimeline("head");
  }

  async function headTimelineOrNull(): Promise<Timeline | null> {
    try {
      return await baseTimeline();
    } catch (err) {
      if (err instanceof ScarletApiError && err.status === 404) return null;
      throw err;
    }
  }

  const preparations = new Map<string, Promise<void>>();

  /**
   * Tell the editor once that the run is waiting on media work, and again when it's ready, so a
   * tool the agent keeps calling to collect the result reads as waiting rather than as fresh work.
   */
  const waits = new Set<string>();
  function waitingOn(what: "transcript" | "sound" | "dialogue", mediaId: string, job: Promise<unknown>) {
    const key = JSON.stringify([what, mediaId]);
    if (waits.has(key)) return;
    waits.add(key);
    const label = what === "transcript" ? "the transcript" : what === "sound" ? "the sound analysis" : "dialogue analysis";
    void postEvent({ type: "log", text: `Waiting for ${label}`, data: { kind: "media_wait", wait: what, mediaId } });
    const since = Date.now();
    // Keep the reason with the event: the task's history is often the only record of why a wait failed.
    void job.then(() => undefined, (err: unknown) => describeError(err)).then(error => {
      waits.delete(key);
      return postEvent({ type: "log", text: error !== undefined ? `Couldn’t prepare ${label}` : `Ready: ${label}`,
        data: { kind: "media_wait", wait: what, mediaId, done: true, waitedMs: Date.now() - since, ...(error !== undefined ? { failed: true, error } : {}) } });
    });
  }

  async function prepare(mediaId: string, kind: "transcript" | "waveform") {
    const result = await client.prepareMedia(projectId, mediaId, kind);
    if (result.state === "ready") return;
    for (;;) {
      const { task: t, waited } = await client.waitForTranscription(result.taskId);
      // The transcript can be read once it has its words. The task then goes on to align them.
      if (t.state === "done" || (t.progress?.words?.fraction ?? 0) >= 1) return;
      if (t.state !== "running" && t.state !== "queued" && t.state !== "claimed") {
        throw new Error(t.error || `Transcription ${t.state} for ${mediaId}.`);
      }
      // An older engine or another process's transcription has no local event to await.
      if (!waited) await delay(1500, undefined, { ref: false });
    }
  }

  function ensureTranscriptWait(mediaId: string) {
    const key = `transcript/${mediaId}`;
    let job = preparations.get(key);
    if (!job) {
      job = prepare(mediaId, "transcript");
      preparations.set(key, job);
      const settled = job;
      void settled.then(() => preparations.get(key) === settled && preparations.delete(key), () => preparations.get(key) === settled && preparations.delete(key));
    }
    waitingOn("transcript", mediaId, job);
  }

  /** A recording's saved transcript: ready, or how far along it is. Undefined when Scarlet can't say. */
  async function transcriptState(mediaId: string): Promise<{ ready: true } | { ready: false; note: string } | undefined> {
    try {
      const prepared = await client.prepareMedia(projectId, mediaId, "transcript");
      if (prepared.state === "ready") return { ready: true };
      const { task: t } = await client.task(prepared.taskId, "none");
      return { ready: false, note: transcriptionNote(t.progress) };
    } catch (err) {
      unavailableOnce(`failed to read how far the transcript of ${mediaId} is`, err);
      return undefined;
    }
  }

  async function readPrepared<T>(mediaId: string, kind: "transcript" | "waveform", read: () => Promise<T>): Promise<T> {
    const key = `${kind}/${mediaId}`;
    try {
      const result = await read();
      preparations.delete(key);
      return result;
    } catch (err) {
      if (!(err instanceof ScarletApiError && err.status === 404) || err.code === "project_resource_missing") throw err;
    }
    let job = preparations.get(key);
    if (!job) {
      job = prepare(mediaId, kind);
      preparations.set(key, job);
    }
    // Keep long jobs alive across MCP call deadlines. A subsequent tool call joins the same job.
    try {
      if (await raceTimeout(job, 15_000, "pending" as const) === "pending") {
        waitingOn(kind === "transcript" ? "transcript" : "sound", mediaId, job);
        const state = kind === "transcript" ? await transcriptState(mediaId) : undefined;
        throw new MediaPreparing(`Scarlet is preparing the ${kind} for ${mediaId}${state && !state.ready ? ` (${state.note})` : ""}. Continue other work, then call this tool again to collect the result. No editor action is needed.`);
      }
    } catch (err) {
      if (!(err instanceof MediaPreparing)) preparations.delete(key);
      throw err;
    }
    preparations.delete(key);
    return read();
  }

  async function getTranscript(mediaId: string, opts: { from?: number; to?: number; granularity?: "word" | "segment" } = {}, prepareMissing = true) {
    const read = () => client.transcript(mediaId, opts);
    try {
      return await (prepareMissing ? readPrepared(mediaId, "transcript", read) : read());
    } catch (err) {
      if (err instanceof ScarletApiError && (err.code === "no_audio" || (!prepareMissing && err.status === 404))) return null;
      throw err;
    }
  }

  /**
   * A media's words in transcript_get order. The position in this list is the word's stable index,
   * shared by every tool that shows or accepts word references. Only a complete transcript is kept.
   *
   * The engine saves a transcript when Whisper ends and goes on placing its words on the audio. Until that is done
   * the words are read again every couple of seconds: their order holds while they are placed, and their times are
   * final only up to `through`. Once placed, a reread of the stretches without words can add words, which moves the
   * indices after them (`sameWordsAsRead` refuses a reference from the list before). With `through` the call
   * resolves once the times are final that far, waiting up to `waitMs`, and otherwise says how far alignment has come. Whatever turns a word time into a cut edge or a measurement
   * asks this way; reading and searching the words does not need to.
   */
  const edgeWaitMs = deps.alignmentWaitMs ?? EDGE_WAIT_MS;
  const wordLists = new Map<string, TranscriptWord[]>();
  const aligningWords = new Map<string, { words: TranscriptWord[]; through: number; at: number; saved: string }>();
  const readingWords = new Map<string, Promise<TranscriptWord[] | null>>();
  const recordedTranscripts = new Map<string, string>();
  /** Which save of a transcript this is. The engine saves it again at every turn of alignment, with a new time. */
  const transcriptSave = (t: Pick<Transcript, "id" | "createdAt" | "aligning">) => JSON.stringify([t.id, t.createdAt, t.aligning?.through]);
  async function cacheTranscriptWords(mediaId: string, t: Transcript | null) {
    const words = t?.segments.length ? flattenWords(t) : null;
    if (task?.context.recordTranscriptDigests && words) {
      const sha256 = wordDigest(words);
      if (recordedTranscripts.get(mediaId) !== sha256) {
        const result = await postEvent({ type: "log", text: "", data: { kind: "eval_transcript", mediaId, count: words.length, sha256 } });
        if (result.posted) recordedTranscripts.set(mediaId, sha256);
      }
    }
    if (words && t!.aligning) aligningWords.set(mediaId, { words, through: t!.aligning.through, at: Date.now(), saved: transcriptSave(t!) });
    else if (words) {
      aligningWords.delete(mediaId);
      wordLists.set(mediaId, words);
    }
    return words;
  }
  const hasCachedWords = (mediaId: string) => wordLists.has(mediaId) || aligningWords.has(mediaId) || readingWords.has(JSON.stringify([mediaId, true]));
  function readWords(mediaId: string, prepareMissing: boolean): Promise<TranscriptWord[] | null> {
    const ready = wordLists.get(mediaId);
    if (ready) return Promise.resolve(ready);
    const partial = aligningWords.get(mediaId);
    if (partial && Date.now() - partial.at < 1500) return Promise.resolve(partial.words);
    // A read that may not prepare can come back empty, so a preparing read never joins it.
    const key = JSON.stringify([mediaId, prepareMissing]);
    let job = readingWords.get(key);
    if (!job) {
      // While the words are placed, the transcript is asked first for how far alignment is, without its words: an hour's
      // words were read again every couple of seconds, and most reads found the save they had.
      const unchanged = partial ? client.transcript(mediaId, { from: 0, to: 0, granularity: "segment" })
        .then(head => transcriptSave(head) === partial.saved, () => false) : Promise.resolve(false);
      job = unchanged.then(same => {
        if (!same) return undefined;
        partial!.at = Date.now();
        return partial!.words;
      }).then(kept => kept ?? getTranscript(mediaId, { granularity: "word" }, prepareMissing).then(t => cacheTranscriptWords(mediaId, t)));
      readingWords.set(key, job);
      void job.catch(() => {}).finally(() => readingWords.delete(key));
    }
    return job;
  }
  /** The source second up to which a transcript's word times are final. Infinity once alignment is done. */
  const settledThrough = (mediaId: string) => wordLists.has(mediaId) ? Infinity : aligningWords.get(mediaId)?.through ?? Infinity;
  async function transcriptWords(mediaId: string, prepareMissing = true, through?: number, waitMs = 0): Promise<TranscriptWord[] | null> {
    const deadline = Date.now() + waitMs;
    for (;;) {
      const words = await readWords(mediaId, prepareMissing);
      const settled = settledThrough(mediaId);
      if (!words || through === undefined || settled > through) return words;
      if (Date.now() + 2000 > deadline) {
        throw new MediaPreparing(`Scarlet is still placing the words of ${mediaId} on the audio: their times are final up to ${settled.toFixed(0)} s, and this needs them up to ${through.toFixed(0)} s. ` +
          "Alignment moves forward through the recording, so earlier passages can be checked and saved now. Call this tool again for the rest. No editor action is needed.");
      }
      await delay(2000, undefined, { ref: false });
    }
  }

  /**
   * The word lists each recording's indices were shown to the model from, the latest last. While Scarlet places the
   * words, the engine reads stretches with sound and no words again and can add words the transcript missed, which moves
   * every index after them. A reference resolved against another list than the one read would cut beside other words.
   * The model can hold indices from any list it was shown, so each is kept until it is told its indices moved and reads
   * again (`staleWords`), and a reference whose words differ between them is refused.
   */
  const wordsShown = new Map<string, WordSnapshot[]>();
  const staleWords = new Set<string>();
  const snapshots = new WeakMap<readonly TranscriptWord[], WordSnapshot>();
  const snapshotOf = (texts: readonly string[], searchId?: string): WordSnapshot =>
    ({ texts, searchId, print: `${texts.length}:${createHash("sha1").update(texts.join("\u0000")).digest("hex")}` });
  function wordSnapshot(words: readonly TranscriptWord[]) {
    let snapshot = snapshots.get(words);
    if (!snapshot) snapshots.set(words, snapshot = snapshotOf(words.map(w => w.text)));
    return snapshot;
  }
  // Which words of a recording were heard only on the input its dialogue isn't on, by transcript index, once their times are final.
  const inputLabels = new Map<string, Map<number, boolean>>();
  const noInputs = new Set<string>();
  function showSnapshot(mediaId: string, snapshot: WordSnapshot) {
    const shown = wordsShown.get(mediaId) ?? [];
    // Words found since moved the indices on: which input each index was heard on is read again.
    if (shown.at(-1)?.print !== snapshot.print) inputLabels.delete(mediaId);
    // Told its indices moved, the model has read again: the lists before this one are behind it.
    const kept = staleWords.delete(mediaId) ? [] : shown.filter(s => s.print !== snapshot.print).slice(-4);
    wordsShown.set(mediaId, [...kept, snapshot]);
  }
  const latestShownSnapshot = (mediaId: string) => wordsShown.get(mediaId)?.at(-1);
  /** Note the list a tool showed the model word indices from. */
  const showWords = (mediaId: string, words: readonly TranscriptWord[] | null | undefined) => {
    if (words) showSnapshot(mediaId, wordSnapshot(words));
  };
  function sameWordsAsRead(mediaId: string, words: readonly TranscriptWord[], from?: number, to?: number) {
    const shown = wordsShown.get(mediaId);
    if (!shown?.length) return;
    const current = wordSnapshot(words), latest = shown.at(-1)!;
    // The words a reference names, as each list shown reads them: one that reads them otherwise could be the one it came from.
    const named = (list: readonly string[]) => from === undefined ? "" : list.slice(from, (to ?? from) + 1).join("\u0000");
    const other = latest.print !== current.print ? latest : from === undefined ? undefined
      : shown.find(s => s.print !== current.print && named(s.texts) !== named(current.texts));
    if (!other) return;
    staleWords.add(mediaId);
    throw new Error(`The transcript of ${mediaId} changed since you read it: Scarlet placed its words on the audio and found words it had missed ` +
      `(${other.texts.length} words then, ${words.length} now), so word indices from that read name other words now. Nothing was placed or saved. ` +
      "Read the passage again (transcript_get, timeline_transcript or dialogue_scan) and give the indices it shows.");
  }

  /** A waveform window with 10 ms buckets and voice activity, for edge evidence. */
  function readLevels(mediaId: string, from: number, to: number): Promise<WaveformResponse> {
    return readPrepared(mediaId, "waveform", () => client.waveform(mediaId, from, to, levelPoints(from, to), true, true));
  }

  /**
   * Measured edge evidence near each source instant that no dialogue scan page covers, so
   * dialogue_check_join, word references and dialogue_apply_cuts judge an edge from the recording
   * even without a scan. Only the first audio stream is measured; other streams keep needing a scan.
   */
  const measured: JoinPage[] = [];
  const measuring = new Map<string, Promise<void>>();
  /** Prepared levels in five-minute stretches of a recording, read once each, with the levels speech and the room sit at in each. */
  const levelChunks = new Map<string, Promise<{ levels: GapLevels; speech: number; room: number }>>();
  /** Where each recording ends, from the project's media. Undefined when the project doesn't say. */
  const recordingEnds = new Map<string, Promise<number | undefined>>();
  function recordingEnd(mediaId: string) {
    let end = recordingEnds.get(mediaId);
    if (!end) {
      recordingEnds.set(mediaId, end = getProject().then(({ project }) => project.media.find(m => m.id === mediaId)?.duration || undefined));
      end.catch(() => recordingEnds.delete(mediaId));
    }
    return end;
  }
  function levelChunk(mediaId: string, from: number, asked: number) {
    const key = `${mediaId}/${from}/${asked}`;
    let chunk = levelChunks.get(key);
    if (!chunk) {
      // Past the end of the recording the engine fills in silence. Read over a whole stretch, that silence pulled the
      // level speech sits at down, on a recording under about two and a half minutes and in the last stretch of any:
      // a breath then read as speech no word explains, and a pause holding one wasn't trimmed. The stretch stops where
      // the recording does.
      chunk = recordingEnd(mediaId).catch(() => undefined).then(end => {
        const to = end !== undefined && end > from ? Math.min(asked, end) : asked;
        return readPrepared(mediaId, "waveform", () => client.waveform(mediaId, from, to, levelPoints(from, to), true));
      }).then(wf => {
        const levels = { from: wf.from, to: wf.to, rms: wf.rms ?? [] };
        return { levels, speech: speakingLevel(levels), room: dbfs(roomRms(levels.rms, (levels.to - levels.from) / Math.max(1, levels.rms.length))) };
      });
      levelChunks.set(key, chunk);
      chunk.catch(() => levelChunks.delete(key));
    }
    return chunk;
  }

  /**
   * On a recording with a mix and two isolated inputs, the words heard only on the input the dialogue isn't on, and the
   * sound on that input alone in each gap. A producer's "got you" and a system chime read like the speaker in the mix:
   * a pass kept both (2026-11-13). Empty for any other recording, and when the reading fails.
   */
  async function otherInput(mediaId: string, words: Array<{ index: number; start: number; end: number }>, gaps: TimeRange[] = []) {
    const empty = { other: new Set<number>(), gaps: gaps.map((): TimeRange[] => []) };
    if (noInputs.has(mediaId) || (!words.length && !gaps.length)) return empty;
    const known = inputLabels.get(mediaId) ?? new Map<number, boolean>();
    inputLabels.set(mediaId, known);
    const ask = words.filter(w => !known.has(w.index));
    // The engine takes at most OTHER_INPUT_WORDS words and OTHER_INPUT_GAPS gaps a request. A transcript read of a long
    // recording, in segments, can hold several times that: it is asked in parts, and the answers put back in order.
    const parts = Math.max(1, Math.ceil(ask.length / OTHER_INPUT_WORDS), Math.ceil(gaps.length / OTHER_INPUT_GAPS));
    const read = async () => {
      const answers = await Promise.all(Array.from({ length: parts }, (_, i) => client.otherInput(projectId, mediaId, {
        words: ask.slice(i * OTHER_INPUT_WORDS, (i + 1) * OTHER_INPUT_WORDS).map(w => [w.start, w.end]),
        gaps: gaps.slice(i * OTHER_INPUT_GAPS, (i + 1) * OTHER_INPUT_GAPS).map(g => [g.start, g.end]) })));
      return { available: answers.every(a => a.available), words: answers.flatMap(a => a.words), gaps: answers.flatMap(a => a.gaps) };
    };
    const reading = await read().catch(withoutOnce(`failed to read which input each word of ${mediaId} came from`, undefined));
    if (!reading) return empty;
    if (!reading.available) { noInputs.add(mediaId); return empty; }
    const settled = settledThrough(mediaId);
    ask.forEach((w, i) => { if (w.end <= settled) known.set(w.index, reading.words[i]!); });
    const fresh = new Map(ask.map((w, i) => [w.index, reading.words[i]!]));
    return { other: new Set(words.filter(w => fresh.get(w.index) ?? known.get(w.index)).map(w => w.index)), gaps: reading.gaps };
  }

  /** What sounds in each stretch between two words of a recording. Undefined where its levels cannot be read. */
  async function gapSounds(mediaId: string, gaps: Array<{ start: number; end: number }>, edge?: number): Promise<Array<GapSound | undefined>> {
    const out: Array<GapSound | undefined> = [];
    for (const gap of gaps) {
      const from = Math.floor(gap.start / CHUNK) * CHUNK;
      // A stretch that runs past its five minutes is read on its own, against the level of the stretch it starts in.
      const [home, own] = await Promise.all([levelChunk(mediaId, from, from + CHUNK),
        gap.end > from + CHUNK ? levelChunk(mediaId, Math.floor(gap.start), Math.ceil(gap.end)) : undefined]);
      out.push(gapSound((own ?? home).levels, gap, home.speech, edge, home.room));
    }
    return out;
  }

  // Both the scan and the next save can cover the same phrase. Keep its reading with the transcript whose timed
  // words it measured. A refreshed alignment gets new readings and keeps the same transcript_get indices.
  const phraseReadings = new WeakMap<TranscriptWord[], { through: number; chunks: Map<number, Promise<QuietPhrase[]>> }>();
  async function readQuietPhrases(mediaId: string, from: number, to: number): Promise<QuietPhrase[]> {
    const words = await transcriptWords(mediaId, false);
    if (!words?.length || to <= from) return [];
    let readings = phraseReadings.get(words);
    if (!readings) {
      readings = { through: Math.min(settledThrough(mediaId), words.reduce((end, w) => Math.max(end, w.end), 0)), chunks: new Map() };
      phraseReadings.set(words, readings);
    }
    const { through, chunks } = readings;
    const found: QuietPhrase[] = [];
    for (let chunk = Math.floor(from / CHUNK); chunk * CHUNK < Math.min(to, through); chunk++) {
      const start = chunk * CHUNK;
      let read = chunks.get(start);
      if (!read) {
        const lo = Math.max(0, start - QUIET_PHRASE_CONTEXT), hi = start + CHUNK + QUIET_PHRASE_CONTEXT;
        // Each chunk owns the phrases starting in it. Read the neighbors across its edges as well, at the same
        // 10 ms resolution. The waveform stays cached as the transcript advances through this chunk.
        read = levelChunk(mediaId, lo, hi).then(({ levels }) =>
          quietPhrases(words, levels, through).filter(p => p.start >= start && p.start < start + CHUNK));
        chunks.set(start, read);
        read.catch(() => chunks.delete(start));
      }
      found.push(...(await read).filter(p => p.start >= from && p.end <= to));
    }
    return found;
  }

  // Parallel edge checks can share a current inventory until the read completes.
  type Inventory = ProjectDetail["project"]["media"];
  let measuringMedia: Promise<Map<string, Inventory[number]>> | undefined;
  const indexMedia = (assets: Inventory) => new Map(assets.map(asset => [asset.id, asset]));
  async function measureAround(points: Array<{ mediaId: string; t: number }>, knownMedia?: Inventory) {
    if (!points.length) return;
    const media = knownMedia ? indexMedia(knownMedia) : await (measuringMedia ??= client.media(projectId)
      .then(({ media }) => indexMedia(media)).finally(() => { measuringMedia = undefined; }));
    await Promise.all(points.map(({ mediaId, t }) => {
      const asset = media.get(mediaId);
      // A source with no sound has no levels to read: the engine refuses it, and the join check leaves it out anyway.
      if (!asset?.duration || asset.hasAudio === false || asset.kind === "image" || (dialogueAudioStream(asset) ?? 0) !== 0) return;
      // A second either side, as far as the recording goes: a window can't reach before its start or past its end.
      const covered = (p: JoinPage) => p.mediaId === mediaId && (p.audioStream ?? 0) === 0 && p.edges && p.start <= Math.max(0, t - 1) && p.end >= Math.min(asset.duration!, t + 1);
      if (evidence.scans.some(covered) || measured.some(covered)) return;
      const from = Math.max(0, Math.floor(t) - 2), to = Math.min(asset.duration, Math.floor(t) + 3);
      const key = JSON.stringify([mediaId, from, to]);
      let job = measuring.get(key);
      if (!job) {
        job = (async () => {
          // The window's words must be where the recording has them. One still waiting for alignment says so.
          const [wf, words] = await Promise.all([readLevels(mediaId, from, to), transcriptWords(mediaId, false, to + 1, edgeWaitMs).catch(err => {
            if (err instanceof MediaPreparing) throw err;
            unavailableOnce(`failed to read the words of ${mediaId} beside an edge`, err);
            return null;
          })]);
          const edges = joinEvidence((words ?? []).filter(w => w.end > from && w.start < to), wf);
          if (edges) measured.push({ mediaId, start: from, end: to, audioStream: 0, edges });
        })().finally(() => measuring.delete(key));
        measuring.set(key, job);
      }
      return job;
    }));
  }
  const joinPages = (): JoinPage[] => [...evidence.scans, ...measured];
  /** Measure every audible source under the given timeline times before a join check. */
  async function measureTimeline(tl: Timeline, times: number[]) {
    await measureAround(audibleSourcePoints(tl, times));
  }
  /** Read the whole interval after the preceding word, even when a long pause puts it outside an ordinary edge reading. */
  async function outgoingPausePages(tl: Timeline, project: ProjectDetail["project"], at: number) {
    const { clips, streams } = dialogueClips(tl, project);
    const outgoing = clips.filter(clip => clip.timelineIn < at && clip.timelineIn + clipDuration(clip) >= at - 1e-6);
    async function wordsThrough(clip: (typeof clips)[number], edge: number) {
      const stream = dialogueAudioStream(clip) ?? streams.get(clip.mediaId);
      if (stream !== 0) throw new Error("Word and level measurements are unavailable for this audio stream.");
      return await transcriptWords(clip.mediaId, false, edge, edgeWaitMs) ?? [];
    }
    const starts = await Promise.all(outgoing.map(async clip => {
      const edge = timelineToSource(clip, at);
      const words = await wordsThrough(clip, edge);
      const last = words.findLast(w => w.end > w.start && w.start >= clip.sourceIn && w.start < edge && w.text.trim() && !isTag(w.text));
      return last ? clipSourceToTimeline(clip, last.start) : -Infinity;
    }));
    const previous = Math.max(...starts);
    if (!Number.isFinite(previous)) return [];
    // Keep each request within the waveform API's 60-second speech window.
    const affected = clips.filter(clip => clip.timelineIn < at && clip.timelineIn + clipDuration(clip) > previous);
    const pages = await Promise.all(affected.map(async clip => {
      const pages: JoinPage[] = [];
      const from = Math.max(clip.sourceIn, timelineToSource(clip, previous) - .3);
      const to = Math.min(clip.sourceOut, timelineToSource(clip, at) + .3);
      const words = await wordsThrough(clip, Math.min(clip.sourceOut, timelineToSource(clip, at)));
      for (let start = from; start < to - 1e-6; start += 59) {
        const end = Math.min(start + 60, to);
        const wf = await readLevels(clip.mediaId, start, end);
        pages.push({ mediaId: clip.mediaId, audioStream: 0, start, end,
          edges: joinEvidence(words.filter(w => w.end > start && w.start < end), wf) });
        if (end === to) break;
      }
      return pages;
    }));
    return pages.flat();
  }
  /**
   * The new clip edges of a save that cut through sound (clipEdgeSound), each measured on its own recording. A
   * recording that can't be measured refuses nothing: the edit goes ahead as asked.
   */
  async function edgesInSound(before: Timeline | null, next: Timeline) {
    const { project } = await getProject();
    const edges = newClipEdges(before, next, project.media);
    if (!edges.length) return [];
    await measureAround(edges.map(e => ({ mediaId: e.mediaId, t: e.source })));
    const pages = joinPages();
    return edges.flatMap(e => {
      const asset = project.media.find(m => m.id === e.mediaId);
      const found = clipEdgeSound(pages, e.mediaId, e.stream ?? (asset && dialogueAudioStream(asset)) ?? 0, e.source, e.side);
      return found ? [{ ...e, ...found }] : [];
    });
  }
  type SoundingEdge = Awaited<ReturnType<typeof edgesInSound>>[number];
  /** What an edge cuts through and where the recording is quiet beside it, for the model to move it by. */
  const edgeInSoundText = (e: SoundingEdge, name = `clip ${e.clipId}`) => `${name} ${e.side === "in" ? "starts" : "ends"} at source ${e.source.toFixed(2)} s ` +
    (e.word ? `inside “${e.word}”, which is sounding there` : "inside a sound the transcript has no word for") +
    (e.wholeAt !== undefined ? ` (clean at ${e.wholeAt.toFixed(2)} s with “${e.word}” whole` + (e.withoutAt !== undefined ? `, or at ${e.withoutAt.toFixed(2)} s without it)` : ")")
      : e.withoutAt !== undefined ? ` (clean at ${e.withoutAt.toFixed(2)} s without “${e.word}”)` : "") +
    (e.fragment ? `: ${Math.round(e.fragment.seconds * 1000)} ms of it would play at ${e.fragment.db} dBFS, and the recording is quiet at ${e.fragment.quietAt.toFixed(2)} s (${e.fragment.quietDb} dBFS)` : "") +
    (e.levels ? ` [dBFS in 20 ms steps: ${e.levels}]` : "");
  const refusalNext = (disputed: Array<{ quietKeptWord?: unknown; takenWords?: unknown }>) => disputed.some(d => d.quietKeptWord)
    ? "Inspect the reported source interval, then resubmit adjusted cuts. To retain the short piece deliberately, include its timeline range as a keep."
    : disputed.every(d => d.takenWords)
      ? "Read each join as it would play, then resubmit the cut with its edge off the words it names, or with them in dropWords."
      : "Check the measured words at each disputed edge with dialogue_check_join. If a quote conflicts, compare the deliveries in dialogue_scan and resubmit the verified edge and words.";
  // Checking a hundred joins can request hundreds of speech windows. Share the available connections across joins.
  const keptSpeechReads = new Lanes(8);
  /** Live reads for the dialogue planner (dialogue-plan.ts), which replay feeds from stored evidence instead. */
  const planSources: DialoguePlanSources = {
    evidence, pages: joinPages, project: async () => (await getProject()).project,
    words: (mediaId, through, prepare = true) => transcriptWords(mediaId, prepare, through, edgeWaitMs), sameWordsAsRead, measure: measureAround,
    readKeptWords: (mediaId, audioStream, from, to, cachedOnly) => keptSpeechReads.run(() => 0, async () => {
      const result = await client.dialogueDetections(projectId, { mediaId, from, to, keptSide: { audioStream, cachedOnly },
        taskId, startedAt: taskStartedAt });
      if (cachedOnly && (result.keptSideUnavailable || result.segments.some(s => s.id !== "kept")))
        throw new NoCachedSpeech("Cached speech measurements are unavailable at this edge.");
      return result.segments.flatMap(s => s.words);
    }),
    sound: async (mediaId, range, betweenWords) => (await gapSounds(mediaId, [range], betweenWords ? undefined : 0))[0],
  };

  return {
    getProject,
    getHeader,
    get lastTimeline() { return lastTimeline; },
    get localRange() { return localRange; },
    set localRange(value) { localRange = value; },
    nextBaseAsk,
    moveBase,
    getTimeline,
    peekTimeline,
    cutAnchor,
    baseTimeline,
    headTimelineOrNull,
    waitingOn,
    ensureTranscriptWait,
    transcriptState,
    readPrepared,
    getTranscript,
    edgeWaitMs,
    cacheTranscriptWords,
    hasCachedWords,
    settledThrough,
    transcriptWords,
    latestShownSnapshot,
    snapshotOf,
    showSnapshot,
    showWords,
    sameWordsAsRead,
    readLevels,
    otherInput,
    gapSounds,
    readQuietPhrases,
    measureAround,
    joinPages,
    measureTimeline,
    outgoingPausePages,
    edgesInSound,
    edgeInSoundText,
    refusalNext,
    planSources,
  };
}

export type MediaSession = ReturnType<typeof createMediaSession>;
export type SoundingEdge = Awaited<ReturnType<MediaSession["edgesInSound"]>>[number];
