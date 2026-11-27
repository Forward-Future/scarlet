import { z } from "zod/v3";
import {
  DEFAULT_RESULT_CHARS,
  fuzzySearchTranscript,
  indexTranscriptWords,
  normalizeTranscriptToken,
  ScarletApiError,
  type AgentCapabilities,
  type ScarletClient,
  type Task,
} from "@scarlet/shared";
import type { TimeRange, TranscriptWord } from "@scarlet/timeline";
import {
  dbfs,
  detectSilences,
  dialogueCutSuggestions,
  downsample,
  OTHER_INPUT,
  round3,
  sparkline,
} from "./analysis.js";
import { fitSync, matchAudio, syncPoints, syncRate } from "./audio-sync.js";
import { referenceAtSecondary, SAID_ON_SCREEN_WAIT, saidOnScreen, secondaryAtReference } from "./said-on-screen.js";
import type { ScreenLine } from "./screen-reading.js";
import { describeGapSound, GAP_SECONDS, type GapSound } from "./gap-sound.js";
import type { MediaSession } from "./media-session.js";
import { eachRecording, RecordingList, recordingsAsked, requireMediaAsset, type SessionErrorHelpers } from "./media-state.js";
import { json, text, type ToolRegistrar } from "./tool-result.js";
import { EXACT_WORD_TIMES, LINE_WORDS, transcriptWordLines } from "./word-lines.js";

/** The most buckets one waveform read returns. */
const WAVEFORM_MAX_POINTS = 4000;

export interface MediaReadToolsDeps {
  tool: ToolRegistrar;
  client: ScarletClient;
  projectId: string;
  caps: AgentCapabilities;
  task?: Task;
  session: MediaSession;
  errors: SessionErrorHelpers;
}

export function registerMediaReadTools(deps: MediaReadToolsDeps) {
  const { tool, client, projectId, caps, task, session, errors } = deps;
  const {
    getProject,
    readPrepared,
    getTranscript,
    transcriptWords,
    settledThrough,
    showWords,
    latestShownSnapshot,
    snapshotOf,
    showSnapshot,
    hasCachedWords,
    cacheTranscriptWords,
    otherInput,
    gapSounds,
  } = session;
  const { withoutOnce } = errors;

  // -- transcript -----------------------------------------------------------

  /** One recording's transcript page, as transcript_get gives it, in `budget` characters at most. */
  async function transcriptPage(mediaId: string, args: { from?: number; to?: number; fromWord?: number; toWord?: number; nextFromWord?: number;
    granularity: "word" | "segment"; format: "json" | "text" }, budget: number): Promise<string> {
    const { from, to, fromWord, toWord, nextFromWord, granularity, format } = args;
    const words = await transcriptWords(mediaId);
    if (!words) return `Media ${mediaId} has no audio track or no transcribed speech. Use waveform_get to inspect its sound.`;
    showWords(mediaId, words);
    const settled = settledThrough(mediaId);
    const estimates = Number.isFinite(settled) ? `Times after ${settled.toFixed(1)} s are estimates until Scarlet has placed those words on the audio. ` +
      "Placing them can add words the transcript missed, which moves the indices after them: a word reference from this read is then refused until you read again." : undefined;
    const inRange = (w: TranscriptWord, index: number) =>
      (from === undefined || w.end >= from) && (to === undefined || w.start <= to) &&
      (fromWord === undefined || index >= fromWord) && (toWord === undefined || index <= toWord);
    const picked: Array<TranscriptWord & { index: number }> = [];
    let nextIndex: number | undefined;
    let minimumSize = 0;
    // Bound the waveform measurements and formatting to what could fit. A word's spelling plus
    // its separator is a lower bound for every format. The exact rendered size decides below.
    for (let index = Math.max(nextFromWord ?? 0, fromWord ?? 0); index < words.length && index <= (toWord ?? Infinity); index++) {
      const word = words[index]!;
      if (!inRange(word, index)) continue;
      minimumSize += word.text.trim().length + 1;
      if (picked.length && minimumSize > budget) { nextIndex = index; break; }
      picked.push({ ...word, index });
    }
    if (!picked.length) return `No speech in that range of ${mediaId} (${words.length} words, #0–#${words.length - 1}). Use waveform_get to inspect pauses.`;
    // The continuation is outside the word list in both formats. A giant single imported
    // word still travels intact: stable indices address words, never fragments of a word.
    function page(render: (count: number, next?: number) => string) {
      const complete = render(picked.length, nextIndex);
      if (complete.length <= budget || picked.length === 1) return complete;
      let low = 1, high = picked.length - 1;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (render(mid, picked[mid]!.index).length <= budget) low = mid;
        else high = mid - 1;
      }
      return render(low, picked[low]!.index);
    }
    if (format === "json") {
      const tuples = picked.map(w => [w.index, w.start, w.end, w.text.trim(), w.speaker ?? null]);
      const { other } = await otherInput(mediaId, picked);
      return page((count, next) => {
        const marked = picked.slice(0, count).filter(w => other.has(w.index)).map(w => w.index);
        return JSON.stringify({ mediaId, ...(estimates && { timesFinalThrough: round3(settled) }),
          words: tuples.slice(0, count), ...(marked.length && { otherInput: marked }), ...(next !== undefined && { nextFromWord: next }) });
      });
    }
    // What the recording holds in each gap between two words, by the index of the word after it.
    const gapped = picked.flatMap((w, i) => {
      // A gap belongs to the word after it, even when it falls exactly between two pages.
      // A fresh ranged read retains its original first-word behavior.
      const previous = words[w.index - 1];
      if (!previous || (!i && nextFromWord === undefined) || !inRange(previous, w.index - 1)) return [];
      return w.start - previous.end >= GAP_SECONDS ? [{ index: w.index, start: previous.end, end: w.start }] : [];
    });
    const [sounds, inputs] = await Promise.all([
      gapSounds(mediaId, gapped).catch(withoutOnce(`failed to read the levels between the words of ${mediaId}`, [] as Array<GapSound | undefined>)),
      otherInput(mediaId, picked, gapped)]);
    const elsewhere = (runs: TimeRange[]) => runs.length
      ? `; ${runs.reduce((n, r) => n + r.end - r.start, 0).toFixed(2)} s of it is on the other input alone (${runs.map(r => `${r.start.toFixed(2)}–${r.end.toFixed(2)}`).join(", ")}): not the speaker` : "";
    const gapNote = new Map(gapped.flatMap((g, i) => sounds[i] || inputs.gaps[i]?.length
      ? [[g.index, `  · ${(g.end - g.start).toFixed(2)} s gap, ${sounds[i] ? describeGapSound(sounds[i]!) : "levels unread"}${elsewhere(inputs.gaps[i] ?? [])}`] as const] : []));
    const said = (w: typeof picked[number]) => inputs.other.has(w.index) ? `${OTHER_INPUT} ${w.text.trim()}` : w.text.trim();
    return page((count, next) => {
      const shown = picked.slice(0, count);
      const lines: string[] = [];
      if (granularity === "segment") {
        let group: typeof picked = [];
        const flush = () => {
          if (!group.length) return;
          const a = group[0]!, b = group.at(-1)!;
          lines.push(`[${a.start.toFixed(2)}-${b.end.toFixed(2)}] #${a.index}-#${b.index}${a.speaker ? ` ${a.speaker}:` : ""} ${group.map(said).join(" ")}`);
          group = [];
        };
        for (const w of shown) {
          const prev = group.at(-1);
          if (prev && (gapNote.has(w.index) || w.start - prev.end >= .6 || w.speaker !== prev.speaker || /[.?!]["”’)]*$/.test(prev.text.trim()))) flush();
          if (gapNote.has(w.index)) lines.push(gapNote.get(w.index)!);
          group.push(w);
        }
        flush();
      } else {
        lines.push(...transcriptWordLines(shown, { note: w => gapNote.get(w.index), said, gapSeconds: GAP_SECONDS }));
      }
      const more = next === undefined ? "" : `\nContinue with nextFromWord=${next}.`;
      return `${mediaId}: words #${picked[0]!.index}–#${shown.at(-1)!.index} of ${words.length}, source seconds.${estimates ? ` ${estimates}` : ""}\n${lines.join("\n")}${more}`;
    });
  }

  tool(
    "transcript_get",
    `Word-timed transcript of a media asset in SOURCE seconds. Each word carries a stable index (#123): the same index transcript_search, timeline_transcript and dialogue_scan show, and the word reference dialogue_check_join and dialogue_apply_cuts accept. Word times locate words; cut edges go where the recording is silent, which the dialogue tools measure. In text, a gap of ${GAP_SECONDS} s or more between two words is followed by a line saying what the recording holds there: quiet, or how much of it is sound at speaking level that no word explains, with its source seconds. That sound is whatever the transcript left out: a word it missed, a cut-off start, a breath, a laugh, typing. On a recording with a mix and two isolated inputs, such as a microphone and the computer's sound, a word heard only on the input the dialogue isn't on reads \`${OTHER_INPUT}\` (a producer on a call, a remote guest, playback), and a gap's line says how much of its sound is on that input alone (a system chime, a remark from the call): neither is the speaker. A missing transcript is started or joined with the configured provider; if the call reports preparation, call again. Narrow with from/to seconds or fromWord/toWord. A long result includes nextFromWord: pass it back with the same range, granularity and format to read the next page. Text format, word: one line per phrase, \`start #index word #index word …\`: the second the line's first word starts, then each word with its index. A line opens after a gap, at a new sentence or speaker (named where it changes), and every ${LINE_WORDS} words. A page of ${EXACT_WORD_TIMES} words or fewer, such as a narrow fromWord/toWord read, lists \`#index start-end word\` lines instead, with each word's own start and end, as json always does. Segment: \`[start-end] #first-#last speaker: text\` lines; json: [index, start, end, text, speaker] tuples, and otherInput listing the indices heard only on the other input. To read the same from/to range on several recordings, such as two microphones, list them as mediaIds instead of mediaId: each is read and paged on its own, in that order (text: one section each; json: \`reads\`), and one that couldn't be read says why in its place. Word indices belong to one recording, so a list takes from/to and no word indices: read on with mediaId and the nextFromWord its section gives.`,
    {
      mediaId: z.string().optional(),
      mediaIds: RecordingList.optional().describe("Several recordings to read over the same from/to range in one call, instead of mediaId"),
      from: z.number().min(0).optional().describe("Start of range, source seconds"),
      to: z.number().min(0).optional().describe("End of range, source seconds"),
      fromWord: z.number().int().min(0).optional().describe("First word index"),
      toWord: z.number().int().min(0).optional().describe("Last word index"),
      nextFromWord: z.number().int().min(0).optional().describe("Continuation word index returned by the previous page"),
      granularity: z.enum(["word", "segment"]).default("word"),
      format: z.enum(["json", "text"]).default("text"),
    },
    async ({ mediaId, mediaIds, ...args }) => {
      const several = recordingsAsked(mediaId, mediaIds);
      const budget = caps.resultChars ?? DEFAULT_RESULT_CHARS;
      if (!several) return text(await transcriptPage(mediaId!, args, budget));
      if (args.fromWord !== undefined || args.toWord !== undefined || args.nextFromWord !== undefined) {
        throw new Error("Word indices belong to one recording. Narrow mediaIds with from/to, or read one recording with mediaId and its word indices.");
      }
      // Each recording has its share of the result. One that has less to say leaves the rest unused.
      const pages = await eachRecording(several, id => transcriptPage(id, args, Math.floor(budget / several.length)));
      if (args.format === "json") {
        return text(JSON.stringify({ reads: pages.map(p => !("read" in p) ? p : p.read.startsWith("{") ? JSON.parse(p.read) : { mediaId: p.mediaId, note: p.read }) }));
      }
      return text(pages.map(p => "read" in p ? p.read : `${p.mediaId}: ${"error" in p ? p.error : p.preparing}`).join("\n\n"));
    },
  );

  const phraseIndexes = new WeakMap<TranscriptWord[], ReturnType<typeof indexTranscriptWords>>();
  // An engine that answers a search without the order of its words never will: later searches read the list at once.
  let searchHasWordOrder = true;
  async function exactMatches(mediaId: string, query: string, contextWords: number) {
    let words: TranscriptWord[] | null;
    if (task?.context.recordTranscriptDigests || hasCachedWords(mediaId) || !searchHasWordOrder) {
      // A cached read tracks alignment; evaluation runs also record the complete timed list they used.
      words = await transcriptWords(mediaId);
    } else {
      const known = latestShownSnapshot(mediaId);
      const result = await readPrepared(mediaId, "transcript", () => client.searchTranscript(mediaId, query, contextWords, known?.searchId ?? ""))
        .catch(err => {
          if (err instanceof ScarletApiError && err.code === "no_audio") return null;
          throw err;
        });
      if (!result) return null;
      if ("matches" in result) {
        if (!result.segmentCount) return null;
        const found = result.wordSnapshot;
        if (found) {
          const snapshot = found.texts ? snapshotOf(found.texts, found.id) : known;
          if (snapshot?.searchId === found.id && snapshot.texts.length === result.wordCount) {
            showSnapshot(mediaId, snapshot);
            return result;
          }
        }
        // Older search results lack the order of the words they refer to. Search the full list we can remember.
        if (!found) searchHasWordOrder = false;
        words = await transcriptWords(mediaId);
      } else {
        // Older engines and very long queries return the original transcript.
        words = await (hasCachedWords(mediaId) ? transcriptWords(mediaId) : cacheTranscriptWords(mediaId, result));
      }
    }
    if (!words) return null;
    showWords(mediaId, words);
    let find = phraseIndexes.get(words);
    if (!find) phraseIndexes.set(words, find = indexTranscriptWords(words));
    return { wordCount: words.length, matches: find(query, contextWords) };
  }

  tool(
    "transcript_search",
    "Search a media asset's transcript. exact: case- and punctuation-insensitive phrase match. fuzzy: token similarity (0..1) that tolerates paraphrase and ASR spelling, for finding every take of a line. Returns each match with source seconds, its first word index and surrounding words.",
    {
      mediaId: z.string(),
      query: z.string().min(1).describe("Phrase to find"),
      match: z.enum(["exact", "fuzzy"]).default("exact"),
      minScore: z.number().min(0).max(1).default(.6).describe("Fuzzy only: lowest similarity to report"),
      contextWords: z.number().int().min(0).max(30).default(6),
    },
    async ({ mediaId, query, match, minScore, contextWords }) => {
      const words = match === "fuzzy" ? await transcriptWords(mediaId) : null;
      if (words) showWords(mediaId, words);
      const result = match === "exact" ? await exactMatches(mediaId, query, contextWords) :
        words && { wordCount: words.length, matches: fuzzySearchTranscript(words, query, { contextWords, minScore }) };
      if (!result) return text(`No transcribed speech to search for media ${mediaId}.`);
      const { matches, wordCount } = result;
      if (!matches.length) return text(`No ${match} matches for "${query}" in ${mediaId} (${wordCount} words searched).`);
      const lines = matches.map((m) => `#${m.wordIndex} [${m.start.toFixed(2)}-${m.end.toFixed(2)}]${"score" in m ? ` ${m.score}` : ""}${m.speaker ? ` ${m.speaker}:` : ""} ${m.context}`);
      return text(`${matches.length} ${match} match(es) for "${query}" in ${mediaId}:\n${lines.join("\n")}`);
    },
  );

  tool(
    "transcript_fix",
    "Correct how a word or phrase is written in the project's transcripts, keeping word times: in every recording, or in mediaIds; from/to (source seconds, with one mediaId) limit it to a stretch. " +
      "`find` is matched as transcript_search's exact search reads words, case and punctuation aside, and a possessive 's after it stays; `replace` is written as given, keeping each word's punctuation and a capital at the start of a sentence. " +
      "Where replace has as many words as find, each word keeps its time; otherwise the new words share the old ones' time and every word index after them moves, so read again before naming those words. " +
      "The fix stays with each transcript: a transcription made again, or its words placed again, reads the same, and transcript reads, searches, captions_generate and screen_reading use it from now on. " +
      "Captions already on the timeline keep their text (the result counts those that still read `find`), and dialogue_scan pages are their own reading of the sound. " +
      "Returns each recording's count of places, and each place's word index before the fix, source seconds and its words before and after.",
    {
      find: z.string().trim().min(1).max(200).describe("The words as the transcript has them, e.g. \"Scarlett\" or \"new ra\""),
      replace: z.string().trim().min(1).max(200).describe("How they should read, e.g. \"Scarlet\" or \"Neura\""),
      mediaIds: RecordingList.optional().describe("Only these recordings. Default: every recording in the project"),
      from: z.number().min(0).optional().describe("Start of the stretch to fix, source seconds of the one recording in mediaIds"),
      to: z.number().min(0).optional().describe("End of the stretch to fix, source seconds of the one recording in mediaIds"),
    },
    async ({ find, replace, mediaIds, from, to }) => {
      const { recordings } = await client.fixTranscriptWords(projectId, { find, replace, mediaIds, from, to });
      // The words this session read are the ones before the fix: read them again, so word references name the fixed words.
      const changed = recordings.filter(r => "count" in r && r.count > 0);
      await Promise.all(changed.map(async r => {
        const words = await cacheTranscriptWords(r.mediaId, await getTranscript(r.mediaId, { granularity: "word" }, false));
        showWords(r.mediaId, words);
      }));
      const wanted = find.split(/\s+/).map(normalizeTranscriptToken).filter(Boolean).join(" ");
      const timeline = await session.headTimelineOrNull().catch(withoutOnce("failed to read the timeline to count the captions that still read it", null));
      const captions = (timeline?.tracks ?? []).flatMap(t => t.clips).filter(c => c.kind === "caption" &&
        ` ${c.text.split(/\s+/).map(normalizeTranscriptToken).filter(Boolean).join(" ")} `.includes(` ${wanted} `)).length;
      const total = changed.reduce((n, r) => n + ("count" in r ? r.count : 0), 0);
      return json({
        find, replace, places: total,
        recordings: recordings.filter(r => !("count" in r) || r.count > 0).map(r => "count" in r
          ? { mediaId: r.mediaId, name: r.name, count: r.count, ...(r.wordsAdded && { wordsAdded: r.wordsAdded }),
            places: r.places.map(p => ({ index: p.index, start: round3(p.start), end: round3(p.end), before: p.before, after: p.after })) }
          : r),
        ...(!total && { note: `No transcript reads "${find}"${mediaIds ? " in those recordings" : ""}${from !== undefined || to !== undefined ? " in that stretch" : ""}. transcript_search with match "fuzzy" finds how it was transcribed.` }),
        ...(captions && { captionsStillReading: captions }),
      });
    },
  );

  // -- waveform -------------------------------------------------------------

  /** One recording's levels over a range. The result is drawn at the number of buckets asked of it. */
  async function readWaveform(mediaId: string, from: number, asked: number, opts: { points: number; thresholdDb: number; minSilence: number; suggestCuts: boolean }) {
    const { points, thresholdDb, minSilence, suggestCuts } = opts;
    // The range stops where the recording does. Past its end the engine has nothing and answers with empty buckets,
    // which read as silence that isn't in the recording.
    const duration = (await client.media(projectId)).media.find(m => m.id === mediaId)?.duration;
    const to = duration ? Math.min(asked, duration) : asked;
    if (duration && to <= from) throw new Error(`Choose a range inside 0–${duration.toFixed(2)} s.`);
    if (suggestCuts && to > from + 60) throw new Error("suggestCuts reads at most 60 source seconds per call. Split the range.");
    const threshold = 10 ** (thresholdDb / 20);
    const resolution = suggestCuts ? Math.max(points, Math.ceil((to - from) * 50)) : points;
    const wf = await readPrepared(mediaId, "waveform", () => client.waveform(mediaId, from, to, resolution, true, suggestCuts));
    let dialogue: object | undefined;
    if (suggestCuts) {
      try {
        const transcript = await getTranscript(mediaId, { from: Math.max(0, from - 2), to: to + 2, granularity: "word" });
        const found = dialogueCutSuggestions(transcript, wf, { threshold, minSilence });
        dialogue = { ...found, candidates: found.candidates.map(({ maxPeak, ...c }) => ({ ...c, maxPeakDb: dbfs(maxPeak) })) };
      } catch (err) {
        if (!(err instanceof ScarletApiError && err.code === "transcription_unavailable")) throw err;
        dialogue = { candidates: [], reason: err.message };
      }
    }
    const peaks = wf.peaks.map(p => round3(p));
    const silences = detectSilences(peaks, wf.from, wf.to, { threshold, minDuration: minSilence });
    return (buckets: number) => {
      const shown = downsample(peaks, buckets);
      return { mediaId, from: wf.from, to: wf.to, bucketSeconds: round3((wf.to - wf.from) / Math.max(1, shown.length)),
        peaksDb: shown.map(dbfs), sparkline: sparkline(peaks, 100), silences, speechActivity: wf.speechActivity, dialogue };
    };
  }

  tool(
    "waveform_get",
    "Audio levels for a range of a media asset in source seconds; missing waveforms are prepared automatically. Returns peak level per bucket in dBFS (evenly spaced over from..to), a sparkline, and silences: runs below thresholdDb lasting at least minSilence seconds. With suggestCuts (a window up to 60 s) it also returns the removable interiors of pauses between timed words and the air left either side. " +
      "To read the same range on several recordings, such as two microphones, list them as mediaIds instead of mediaId: the result's `reads` has one reading per recording in that order, and one that couldn't be read carries its own `error` (or `preparing`). A list too long to return whole comes back with fewer buckets on each recording (bucketSeconds).",
    {
      mediaId: z.string().optional(),
      mediaIds: RecordingList.optional().describe("Several recordings to read over the same range in one call, instead of mediaId"),
      from: z.number().min(0).describe("Range start, source seconds"),
      to: z.number().min(0).describe("Range end, source seconds"),
      points: z.number().int().min(10).default(400).describe(`Number of buckets, up to ${WAVEFORM_MAX_POINTS}: a larger request returns ${WAVEFORM_MAX_POINTS} and says so. 400 over 60 s = 0.15 s resolution; the recording is measured every 0.02 s, so more than 50 a second adds nothing`),
      thresholdDb: z.number().max(0).default(-26).describe("Peak level in dBFS below which a bucket counts as silent"),
      suggestCuts: z.boolean().default(false),
      minSilence: z.number().min(0).default(0.25).describe("Minimum silence duration to report, seconds"),
    },
    async ({ mediaId, mediaIds, from, to, points: askedPoints, ...opts }) => {
      const several = recordingsAsked(mediaId, mediaIds);
      if (to <= from) throw new Error("`to` must be greater than `from`.");
      // A request past the limit is answered at the limit, and told so. Refused, thirty parallel reads at 6000 points
      // all failed and were all sent again (2026-11-16).
      const points = Math.min(askedPoints, WAVEFORM_MAX_POINTS);
      const capped = askedPoints > points ? { pointsCapped: { asked: askedPoints, returned: points } } : {};
      if (!several) return json({ ...capped, ...(await readWaveform(mediaId!, from, to, { points, ...opts }))(points) });
      const reads = await eachRecording(several, id => readWaveform(id, from, to, { points, ...opts }));
      const budget = caps.resultChars ?? DEFAULT_RESULT_CHARS;
      // The buckets are what grows with a list: fewer of them on each recording until the whole list fits.
      for (let buckets = points; ; ) {
        const body = JSON.stringify({ ...capped, reads: reads.map(r => "read" in r ? r.read(buckets) : r) });
        if (body.length <= budget || buckets <= 10) return text(body);
        buckets = Math.max(10, Math.floor(buckets * budget / body.length * .9));
      }
    },
  );

  tool("audio_sync", "Measure the sync offset between two recordings of the same event from their shared audio: the seconds the secondary starts after the reference (negative = earlier). Placed from source zero at normal speed, the secondary's timelineIn is the reference's timelineIn plus this offset. No offset means no one offset fits the whole recording: then \`fit\` follows the shared sound through it, with \`points\` (secondary seconds and the offset there). constant gives the offset; drift is a clock that runs at another rate (msPerMinute), which secondarySpeed on every secondary clip cancels; steps are steady parts with a jump between them (a dropout or a paused recording), each part placed at its own offset; unclear says why it couldn't tell. When one of the two is transcribed and the other is a video, `saidOnScreen` lists where the words said are found, in the same order, in the text on that video's picture as they are said, whether or not its picture is in the edit yet: `from`-`to` in the speech recording's seconds, `pictureAt` the video's, `said` the words. It is what the two recordings share, not a choice of what to show. A video whose text is still being read says how far it has got (`textRead`).",
    { referenceId: z.string(), secondaryId: z.string() },
    async ({ referenceId, secondaryId }) => {
      if (referenceId === secondaryId) throw new Error("referenceId and secondaryId are the same recording. Choose two different recordings.");
      const { project } = await getProject();
      async function envelope(id: string) {
        const media = requireMediaAsset(project, id);
        const count = Math.floor((media.duration ?? 0) * syncRate);
        if (media.hasAudio === false || !(count > 0)) return new Float64Array();
        const values = new Float64Array(count);
        for (let start = 0; start < count; start += 10000) {
          const end = Math.min(start + 10000, count);
          const wave = await readPrepared(id, "waveform", () => client.waveformPeaks(id, start / syncRate, end / syncRate, end - start));
          if (wave.peaks.length !== end - start) {
            throw new Error(`The waveform of ${id} covered ${wave.peaks.length} of ${end - start} samples from ${(start / syncRate).toFixed(1)} s. Retry; a truncated source needs a sync point from the editor.`);
          }
          values.set(wave.peaks, start);
        }
        return values;
      }
      const [reference, secondary] = await Promise.all([envelope(referenceId), envelope(secondaryId)]);
      const match = matchAudio(reference, secondary);
      if (match) return json({ ...match, ...await onScreen(project, referenceId, secondaryId, { kind: "match", offset: match.secondaryStartRelativeToReference }) });
      if (!reference.length || !secondary.length) return json({ matchedWindows: 0, reason: "No unambiguous constant offset from shared audio." });
      // No one offset fits the whole recording. Follow it through the recording to say how it changes.
      const points = syncPoints(reference, secondary);
      const fit = fitSync(points);
      const shown = points.length > 40 ? points.filter((_, i) => i % Math.ceil(points.length / 40) === 0) : points;
      return json({ matchedWindows: 0, reason: "No unambiguous constant offset from shared audio.", fit,
        points: shown.map(p => ({ at: Math.round(p.at), offset: round3(p.offset) })),
        ...await onScreen(project, referenceId, secondaryId, fit) });
    });

  /**
   * Where the words said in one of two synced recordings are in the text on the other's picture: the recording with
   * the most transcribed words is the speech, and the other, when it is a video, the picture. Only the picture's text is
   * read, so a camera's own picture is never read for text. Nothing when neither is transcribed or the other has no picture.
   */
  async function onScreen(project: Awaited<ReturnType<typeof getProject>>["project"], referenceId: string, secondaryId: string, fit: Parameters<typeof secondaryAtReference>[0]) {
    try {
      const counted = await Promise.all([referenceId, secondaryId].map(async id => ({ id, words: await transcriptWords(id, false).catch(withoutOnce(`failed to read the words of ${id} for audio_sync`, null)) ?? [] })));
      const [speech, other] = counted[1]!.words.length > counted[0]!.words.length ? [counted[1]!, counted[0]!] : [counted[0]!, counted[1]!];
      const picture = project.media.find(m => m.id === other.id);
      if (!speech.words.length || picture?.kind !== "video" || !picture.duration) return {};
      const pictureAt = speech.id === referenceId ? secondaryAtReference(fit) : referenceAtSecondary(fit);
      if (!pictureAt) return {};
      const read = await client.get<{ from: number; to: number; readSeconds: number; done: boolean; error?: string; spans: ScreenLine[] }>(
        `/projects/${encodeURIComponent(projectId)}/media/${encodeURIComponent(picture.id)}/screen-text?from=0&to=${picture.duration}&wait=${SAID_ON_SCREEN_WAIT}`);
      const found = saidOnScreen(speech, { id: picture.id, lines: read.spans, duration: picture.duration }, pictureAt);
      const progress = read.done ? {} : { textRead: `${read.readSeconds.toFixed(0)} of ${(read.to - read.from).toFixed(0)} s of ${picture.id}'s text read so far${read.error ? `, stopped: ${read.error}` : ": call audio_sync again for the rest"}` };
      return { saidOnScreen: { ...found, ...progress } };
    } catch (err) {
      return withoutOnce("failed to read where the words said are on screen for audio_sync", {})(err);
    }
  }
}
