import { createHash } from "node:crypto";
import { fileInDirectory } from "@scarlet/render";
import { carriesAudio, clipEnd, mergeRanges, sourceToTimeline, timelineToSource, type MediaClip, type Project, type Timeline, type TimeRange } from "@scarlet/timeline";
import { adjacentRepeatCandidates, closesSentence, cutAnchorOn, findRestarts, flattenWords, joinFragment, joinsPlacedByCuts, normalizeTranscriptToken, sameJoin,
  SILENCE_LEFT_SECONDS, versionJoins, type JoinEdges, type JoinFragment, type JoinHearing, type SaidWord, type SilenceLeft, type Task } from "@scarlet/shared";
import type { Ctx } from "../context.js";
import { acousticWordReader } from "../transcribe/acousticWords.js";
import { EmissionFile } from "../transcribe/emissions.js";
import { readsEnglishSpeech, measureRecordingWords } from "../transcribe/wordAlign.js";
import { transcriptLanguage } from "./transcriptReader.js";
import { dialogueDetector, sharedDialogueDetector } from "./dialogueDetections.js";
import { emissionStore, recordingWav, type RecordingAudio } from "./recordingAudio.js";

interface Word extends TimeRange { text: string }
interface Placement { track: string; clip: MediaClip; source: TimeRange }
interface Heard extends Word { mediaId: string; source: number; sourceEnd: number; clip: string; track: string; clipStart: number; clipEnd: number;
  /** The word as written, for showing. `text` is its normalized token. */
  said: string }
const round = (n: number) => Math.round(n * 1000) / 1000;
const span = (words: Heard[]) => ({ start: round(words[0]!.start), end: round(words.at(-1)!.end) });

/** One side of a join as heard: a played stretch of a recording, its words read from the sound and its transcript words. */
export interface JoinSide { mediaId: string; clipId: string; trackId: string; timelineStart: number; timelineEnd: number; source: TimeRange; heard: Word[]; said: Word[];
  /** Why its sound wasn't read: the recording's language can't be read letter by letter. */
  unheard?: string }

const letters = (text: string) => normalizeTranscriptToken(text).replace(/[^a-z]/g, "").length;
/** Reaches the edge of the played stretch: speech still sounding where the cut is. */
const AT_EDGE = .03;
/** Sound read as letters this far beyond the nearest transcript word belongs to no word the editor will hear. */
const BEYOND = .04;

/**
 * What a join sounds like, read from the recording's speech model frame by frame rather than from the transcript. A cut
 * through a word reads as a short word reaching the edge ("subscrip" for “subscription”); a leftover of the removed take
 * reads as letters the transcript has no word for (“k” of an abandoned “Kimmy K”). Both reached the editor as joins
 * to send back; the transcript, which tidies speech, showed neither.
 */
export function hearJoin(out: JoinSide, inn: JoinSide): JoinHearing[] {
  const found: JoinHearing[] = [];
  const at = Math.round(inn.timelineStart * 1000) / 1000;
  const inside = (side: JoinSide, w: Word) => (w.start + w.end) / 2 >= side.source.start && (w.start + w.end) / 2 < side.source.end;
  const check = (side: JoinSide, which: "out" | "in") => {
    const said = side.said.filter(w => inside(side, w) && letters(w.text)).sort((a, b) => a.start - b.start);
    const heard = side.heard.filter(w => letters(w.text)).sort((a, b) => a.start - b.start);
    const word = which === "out" ? said.at(-1) : said[0];
    const edgeWord = which === "out" ? heard.at(-1) : heard[0];
    if (!edgeWord) return;
    const edge = which === "out" ? side.source.end : side.source.start;
    const reaches = which === "out" ? edgeWord.end >= edge - AT_EDGE : edgeWord.start <= edge + AT_EDGE;
    // Letters past the last word the transcript plays, or before the first: a fragment the cut left in.
    const stray = !word || (which === "out" ? edgeWord.start > word.end + BEYOND : edgeWord.end < word.start - BEYOND);
    if (stray) {
      if (letters(edgeWord.text) >= 1 && edgeWord.end - edgeWord.start >= .06)
        // The kept word beside it plays whole. It was reported as `expected`, and a pass read a sigh before “This” as
        // “This” cut short: it moved the edge out to take in the whole sigh, where the edge goes past it (2026-11-13).
        found.push({ at, mediaId: side.mediaId, side: which, issue: "fragment", heard: edgeWord.text,
          ...(word && { keptWord: word.text, keptWordAt: Math.round((which === "out" ? word.end : word.start) * 1000) / 1000 }), source: Math.round(edgeWord.start * 1000) / 1000 });
      return;
    }
    // The kept word itself, sounding at the edge and heard short: the cut goes through it.
    if (reaches && letters(edgeWord.text) <= .7 * letters(word!.text) && letters(word!.text) - letters(edgeWord.text) >= 2)
      found.push({ at, mediaId: side.mediaId, side: which, issue: "clipped", heard: edgeWord.text, expected: word!.text, source: Math.round(edgeWord.start * 1000) / 1000 });
  };
  check(out, "out");
  check(inn, "in");
  return found;
}

/** Each join on each track of the parts read, as the sides that meet there. */
export function joinSides(sides: JoinSide[]) {
  const pairs: Array<[JoinSide, JoinSide]> = [];
  const byTrack = new Map<string, JoinSide[]>();
  for (const s of sides) byTrack.set(s.trackId, [...(byTrack.get(s.trackId) ?? []), s]);
  for (const list of byTrack.values()) {
    list.sort((a, b) => a.timelineStart - b.timelineStart);
    for (let i = 1; i < list.length; i++) {
      const a = list[i - 1]!, b = list[i]!;
      // Touching, or overlapping by a short crossfade. A split that plays on through the same source is no join.
      if (Math.abs(b.timelineStart - a.timelineEnd) > .2 || (a.mediaId === b.mediaId && Math.abs(a.source.end - b.source.start) < 1e-3)) continue;
      pairs.push([a, b]);
    }
  }
  return pairs;
}

function placements(project: Project, tl: Timeline): Placement[] {
  const audible = new Set(project.media.filter(carriesAudio).map(m => m.id));
  return tl.tracks.filter(t => t.kind !== "caption" && !t.muted).flatMap(t => t.clips.flatMap(c =>
    c.kind === "media" && c.enabled && c.volume > 0 && audible.has(c.mediaId)
      ? [{ track: t.id, clip: c, source: { start: c.sourceIn, end: c.sourceOut } }] : []));
}

/** Anchor a selection in its original footage, since a ripple changes its timeline times. */
function inScope(current: Placement[], original: Placement[], ctx: Task["context"], playback: Task["context"]) {
  if (ctx.mediaId) current = current.filter(p => p.clip.mediaId === ctx.mediaId);
  if (ctx.time === undefined || ctx.end === undefined) return current;
  const { time, end, mediaId } = ctx;
  const selected = original.flatMap(({ clip, track }) => {
    const start = Math.max(time, clip.timelineIn), stop = Math.min(end, clipEnd(clip));
    return stop > start ? [{ track, mediaId: clip.mediaId, start: timelineToSource(clip, start), end: timelineToSource(clip, stop) }] : [];
  });
  return current.flatMap(p => {
    // Reusing the same source later in this track does not put that other placement inside a timeline selection.
    const start = mediaId ? p.source.start : timelineToSource(p.clip, Math.max(playback.time!, p.clip.timelineIn));
    const stop = mediaId ? p.source.end : timelineToSource(p.clip, Math.min(playback.end!, clipEnd(p.clip)));
    const ranges = mediaId ? [{ start: time, end }] : selected.filter(s => s.mediaId === p.clip.mediaId && s.track === p.track);
    return mergeRanges(ranges).flatMap(r => {
      const source = { start: Math.max(r.start, start), end: Math.min(r.end, stop) };
      return source.end > source.start ? [{ ...p, source }] : [];
    });
  });
}

function occurrence(words: Heard[], before?: Heard, after?: Heard) {
  const clipId = words[0]!.clip;
  if (words.some(w => w.clip !== clipId)) return;
  const sourceWord = (w: Heard) => ({ text: w.text, start: w.source, end: w.sourceEnd });
  return { clipId, mediaId: words[0]!.mediaId, words: words.map(sourceWord),
    before: before?.clip === clipId ? sourceWord(before) : undefined,
    after: after?.clip === clipId ? sourceWord(after) : undefined };
}

function repeatedPhrases(heard: Heard[], acrossTracks = false) {
  const found = [];
  const candidates = adjacentRepeatCandidates(heard.map(w => w.text), heard.map(w => w.start));
  for (let i = 0; i + 1 < heard.length; i++) {
    for (const n of candidates(i)) {
      const a = heard.slice(i, i + n), b = heard.slice(i + n, i + n * 2);
      const group = [...a, ...b];
      if (acrossTracks && (!group.some(w => w.track !== a[0]!.track) ||
          group.some((w, k) => k && w.track !== group[k - 1]!.track && group[k - 1]!.clipEnd > w.clipStart + .001))) continue;
      const first = span(a), second = span(b);
      if (second.start < first.end - .001 || second.start - first.end > 3) continue;
      if (group.some((w, k, all) => k && (w.start < all[k - 1]!.end - .001 || w.start - all[k - 1]!.end > 3))) continue;
      const before = heard.slice(Math.max(0, i - 5), i);
      const after = heard.slice(i + 2 * n, i + 2 * n + 7);
      const anchor = [...a, ...b].map(w => [w.track, w.mediaId, round(w.source), w.text]);
      const id = createHash("sha256").update(JSON.stringify(anchor)).digest("hex").slice(0, 20);
      found.push({ id, phrase: a.map(w => w.text).join(" "), first, second,
        occurrences: { first: occurrence(a, heard[i - 1], b[0]), second: occurrence(b, a.at(-1), heard[i + 2 * n]) },
        before: before.map(w => w.text).join(" "), after: after.map(w => w.text).join(" "),
        precedingEnd: before.length ? round(before.at(-1)!.end) : undefined, followingStart: after.length ? round(after[0]!.start) : undefined,
        atJoin: a.at(-1)!.clip !== b[0]!.clip });
      i += n - 1;
      break;
    }
  }
  return found;
}

/** A transcript token that names a sound, not a word: “*click*”, “[music]”, “(laughs)”. */
const names = (text: string) => /^\s*[[(*♪].*[\])*♪]\s*$/u.test(text);
/** A word's timing can run on over the silence after it. No word is taken to sound longer than this. */
const LONGEST_WORD = 1.5;

/**
 * Phrases the transcript's words play twice within a moment. The speech reading above spells each word from its
 * sound, and two sayings of seven words rarely spell alike, so it finds a doubled word and misses a doubled sentence:
 * on one pass it reported a single repeat while twenty restarts played (2026-11-16). `first` is the whole first
 * attempt, up to where the phrase starts again, since that is what a restart leaves to remove.
 */
function restarts(spoken: Heard[]) {
  const found = [];
  for (const r of findRestarts(spoken.map(w => w.text), spoken.map(w => w.start), spoken.map(w => w.end), { cutOffWords: true })) {
    const again = r.again ?? r.length;
    const attempt = spoken.slice(r.at, r.next), a = spoken.slice(r.at, r.at + r.length), b = spoken.slice(r.next, r.next + again);
    const before = spoken.slice(Math.max(0, r.at - 5), r.at), after = spoken.slice(r.next + again, r.next + again + 7);
    const anchor = [...a, ...b].map(w => [w.track, w.mediaId, round(w.source), w.text]);
    const id = createHash("sha256").update(JSON.stringify(["restart", anchor])).digest("hex").slice(0, 20);
    const between = attempt.slice(r.length).map(w => w.said).join(" ");
    found.push({ id, phrase: a.map(w => w.said).join(" "), first: span(attempt), second: span(b),
      occurrences: { first: occurrence(attempt, spoken[r.at - 1], b[0]), second: occurrence(b, attempt.at(-1), spoken[r.next + again]) },
      before: before.map(w => w.said).join(" "), after: after.map(w => w.said).join(" "),
      precedingEnd: before.length ? round(before.at(-1)!.end) : undefined, followingStart: after.length ? round(after[0]!.start) : undefined,
      atJoin: attempt.at(-1)!.clip !== b[0]!.clip, restart: true as const, ...(between && { between }) });
  }
  return found;
}

/** Stretches of the edit that play no word on any dialogue recording. */
function silencesLeft(spoken: Heard[], from: number): SilenceLeft[] {
  const found: SilenceLeft[] = [];
  let last: Heard | undefined, lastEnd = -Infinity;
  for (const w of spoken) {
    if (last && w.start - lastEnd >= from - 1e-6) {
      const id = createHash("sha256").update(JSON.stringify(["silence", last.mediaId, round(last.source), w.mediaId, round(w.source)])).digest("hex").slice(0, 20);
      found.push({ id, start: round(lastEnd), end: round(w.start), seconds: round(w.start - lastEnd), mediaId: last.mediaId,
        source: round(Math.min(last.sourceEnd, last.source + LONGEST_WORD)), after: last.said, before: w.said, atJoin: last.clip !== w.clip });
    }
    const end = Math.min(w.end, w.start + LONGEST_WORD);
    if (end > lastEnd) { last = w; lastEnd = end; }
  }
  return found;
}

/**
 * The joins that took words out of a sentence, each with what the edit plays either side of it (joinFragment), but for
 * the ones the dialogue cut tool placed. Read from the transcript and the pieces alone, so it needs no audio: a
 * recording whose sound can't be read is still listed.
 */
function dividedSentences(ctx: Ctx, project: Project, parts: Placement[], placedByCuts: readonly JoinEdges[]): JoinFragment[] {
  const transcripts = new Map<string, SaidWord[] | null>();
  const wordsOf = (mediaId: string) => {
    if (!transcripts.has(mediaId)) {
      const media = project.media.find(m => m.id === mediaId);
      const transcript = media?.transcriptId ? ctx.repos.transcripts.get(media.transcriptId) : undefined;
      // Indexed as the pass names words (flattenWords), then put in the order they sound: a word the aligner placed
      // late sits out of the transcript's order, and it plays where it sounds.
      const lastOfSegment = new Set<number>();
      let count = 0;
      for (const segment of transcript?.segments ?? []) {
        count += segment.words.length || (segment.text.trim() ? segment.text.trim().split(/\s+/).length : 0);
        if (count) lastOfSegment.add(count - 1);
      }
      transcripts.set(mediaId, transcript ? flattenWords(transcript)
        .map((w, index) => ({ text: w.text, start: w.start, end: w.end, index, endsSentence: closesSentence(w.text) || lastOfSegment.has(index) }))
        // A word the recording has no sound for takes no time and isn't heard: the join plays the words either side of it.
        .filter(w => w.end > w.start && w.text.trim() && !names(w.text))
        .sort((a, b) => (a.start + a.end) - (b.start + b.end) || a.index - b.index) : null);
    }
    return transcripts.get(mediaId)!;
  };
  const found: JoinFragment[] = [];
  const byTrack = new Map<string, Placement[]>();
  for (const p of parts) byTrack.set(p.track, [...(byTrack.get(p.track) ?? []), p]);
  for (const list of byTrack.values()) {
    const at = (p: Placement, source: number) => sourceToTimeline(p.clip, source);
    list.sort((a, b) => at(a, a.source.start) - at(b, b.source.start));
    for (let i = 1; i < list.length; i++) {
      const a = list[i - 1]!, b = list[i]!;
      const aEnd = at(a, a.source.end), bStart = at(b, b.source.start);
      // The same join the sound is read at (joinSides): touching or crossfaded pieces of one recording, the later
      // one further on in it. A part the scope cut short ends where the scope does, not at a join.
      if (a.clip.mediaId !== b.clip.mediaId || Math.abs(bStart - aEnd) > .2 || b.source.start - a.source.end < 1e-3) continue;
      if (Math.abs(a.source.end - a.clip.sourceOut) >= 1e-3 || Math.abs(b.source.start - b.clip.sourceIn) >= 1e-3) continue;
      // A join the dialogue cut tool placed took out the words the pass named, and the tool reported what it left.
      if (placedByCuts.some(j => sameJoin(j, { mediaId: a.clip.mediaId, out: a.source.end, in: b.source.start }))) continue;
      const words = wordsOf(a.clip.mediaId);
      const evidence = words && joinFragment(words, a.source.end, b.source.start, a.source.start, b.source.end);
      if (!evidence) continue;
      const mediaId = a.clip.mediaId, out = round(a.source.end), inn = round(b.source.start);
      found.push({ id: createHash("sha256").update(JSON.stringify(["fragment", a.track, mediaId, out, inn])).digest("hex").slice(0, 20),
        at: round(aEnd > bStart ? (aEnd + bStart) / 2 : bStart), mediaId, out, in: inn, ...evidence });
    }
  }
  return found.sort((a, b) => a.at - b.at);
}

/** A version's joins don't change. Kept by project and version, so each version is read once however often a pass checks. */
const joinsOfVersion = new Map<string, JoinEdges[]>();

/**
 * The joins of `tl` that a dialogue cut placed (joinsPlacedByCuts), read from the versions that led to it and the
 * change that saved each. A version outside the saved history has none: every join it divides a sentence at is listed.
 */
function cutToolJoins(ctx: Ctx, project: Project, tl: Timeline): JoinEdges[] {
  const links = new Map(ctx.repos.versions.links(project.id).map(link => [link.version, link]));
  const history: Array<{ joins: JoinEdges[]; byCutTool: boolean }> = [];
  const seen = new Set<string>();
  for (let version: string | null = tl.version; version && links.has(version) && !seen.has(version); version = links.get(version)!.parent) {
    seen.add(version);
    const key = `${project.id}:${version}`;
    let joins = joinsOfVersion.get(key);
    if (!joins) {
      const saved = version === tl.version ? tl : ctx.repos.versions.get(project.id, version)?.timeline;
      if (!saved) break;
      joins = versionJoins(saved);
      if (joinsOfVersion.size > 4000) joinsOfVersion.clear();
      joinsOfVersion.set(key, joins);
    }
    const changeId = links.get(version)!.changeId;
    history.unshift({ joins, byCutTool: !!changeId && !!ctx.repos.changes.get(changeId)?.cutReasons?.length });
  }
  return joinsPlacedByCuts(history);
}

function clipById(tl: Timeline, id: string) {
  for (const t of tl.tracks) for (const c of t.clips) if (c.id === id && c.kind === "media") return c;
}

/** Read each audible source separately so two live microphones never form a spurious repeated word together. */
export async function auditDialogueAudio(ctx: Ctx, project: Project, tl: Timeline, task: Task, signal: AbortSignal, silencesFrom = SILENCE_LEFT_SECONDS) {
  const scope = task.context;
  const current = placements(project, tl);
  const base = scope.version && scope.version !== tl.version && scope.time !== undefined && scope.end !== undefined
    ? ctx.repos.versions.get(project.id, scope.version)?.timeline : undefined;
  const parts = inScope(current, base ? placements(project, base) : current, scope, cutAnchorOn(scope, tl, base));
  const tracks = new Map<string, Heard[]>(), spokenTracks = new Map<string, Heard[]>();
  const unavailable: Array<{ mediaId: string; reason: string }> = [];
  const sides: JoinSide[] = [];
  for (const mediaId of new Set(parts.map(p => p.clip.mediaId))) {
    signal.throwIfAborted();
    const media = project.media.find(m => m.id === mediaId)!;
    const selected = parts.filter(p => p.clip.mediaId === mediaId);
    let store: EmissionFile | null = null, recording: RecordingAudio | undefined;
    const heard: Heard[] = [], spoken: Heard[] = [];
    try {
      const file = fileInDirectory(ctx.paths.media(project.id), media.path);
      if (!file) throw new Error("The source recording is unavailable.");
      const language = transcriptLanguage(ctx, project.id, media);
      const add = (p: Placement, w: Word, into = heard) => {
        const { source, track, clip } = p;
        const at = (s: number) => sourceToTimeline(clip, s);
        const text = normalizeTranscriptToken(w.text);
        if (text) into.push({ text, said: w.text.trim(), source: Math.max(source.start, w.start), sourceEnd: Math.min(source.end, w.end), mediaId, track, clip: clip.id, clipStart: clip.timelineIn, clipEnd: clipEnd(clip),
          start: at(Math.max(w.start, source.start)), end: at(Math.min(w.end, source.end)) });
      };
      const lang = language || ctx.settings().transcription.language;
      const side = ({ clip, track, source }: Placement) => {
        const at = (t: number) => sourceToTimeline(clip, t);
        return { mediaId, clipId: clip.id, trackId: track, timelineStart: at(source.start), timelineEnd: at(source.end), source };
      };
      if (lang && lang !== "auto" && !readsEnglishSpeech(lang)) {
        // Read the verbatim dialogue scan in its own language. Use the same authorised detector and page cache as the pass.
        const detector = dialogueDetector(ctx);
        const pages = new Map<number, Word[]>();
        for (const part of selected) {
          for (let start = Math.floor(part.source.start / 58) * 58; start < part.source.end; start += 58) {
            const end = Math.min(media.duration ?? part.source.end, start + 60);
            let words = pages.get(start);
            if (!words) {
              const page = await detector.detect(project.id, media, start, end, task.id, task.startedAt);
              words = page.segments.flatMap(s => s.words);
              pages.set(start, words);
            }
            for (const word of words) {
              const middle = (word.start + word.end) / 2;
              if (middle >= Math.max(start, part.source.start) && middle < Math.min(start + 58, part.source.end)) add(part, word);
            }
          }
        }
        // Its joins still play. They go back unheard rather than as clean.
        const unheard = `Its speech (${lang}) can't be read letter by letter, so these joins weren't heard.`;
        for (const part of selected) sides.push({ ...side(part), heard: [], said: [], unheard });
      } else {
        const path = await emissionStore(ctx, project.id, file);
        store = await EmissionFile.open(path);
        const ranges = mergeRanges(selected.map(p => p.source));
        if (!store || ranges.some(r => store!.missing(...store!.frameRange(r.start, r.end)).length)) {
          await store?.close(); store = null;
          const wav = async () => (recording ??= await recordingWav(ctx, file, signal)).wav;
          await measureRecordingWords(ctx, mediaId, { file: path, wav }, ranges, signal);
          store = await EmissionFile.open(path);
        }
        if (!store) throw new Error("The recording's speech measurements are unavailable.");
        const transcript = media.transcriptId ? ctx.repos.transcripts.get(media.transcriptId) : undefined;
        const said = transcript?.segments.flatMap(s => s.words).filter(w => w.end > w.start && !/^\s*\[.*\]\s*$/.test(w.text)) ?? [];
        // What a part plays, in the verbatim words the pass's scan read wherever it read them: the transcript tidies a
        // restart away ("including 3D, including three, uh, including its ability" reads "including 3D, including its
        // ability" there), and the restarts it hid played on in finished passes (2026-11-16).
        const scanned = await sharedDialogueDetector(ctx).savedWords(project.id, media, Math.min(...ranges.map(r => r.start)),
          Math.max(...ranges.map(r => r.end))).catch(() => undefined);
        const inScan = (t: number) => !!scanned?.covered.some(r => t >= r.start && t < r.end);
        const playedWords = [...(scanned?.words ?? []), ...said.filter(w => !inScan((w.start + w.end) / 2))];
        for (const part of selected) {
          const [lo, hi] = store.frameRange(part.source.start, part.source.end);
          const reader = acousticWordReader();
          for (let f = lo; f < hi; f += 3000) {
            signal.throwIfAborted();
            reader.read(await store.read(f, Math.min(f + 3000, hi)), f);
          }
          const read = reader.finish();
          for (const word of read) add(part, word);
          // What the part plays: a word is in the part its middle is in.
          for (const word of playedWords) {
            const middle = (word.start + word.end) / 2;
            if (middle >= part.source.start && middle < part.source.end && !names(word.text)) add(part, word, spoken);
          }
          sides.push({ ...side(part), heard: read, said: said.filter(w => w.end > part.source.start - 1 && w.start < part.source.end + 1) });
        }
      }
      for (const w of heard) {
        let words = tracks.get(w.track);
        if (!words) tracks.set(w.track, words = []);
        words.push(w);
      }
      // Without a saved transcript, or in a language read from the verbatim scan, the words read above are what was said.
      for (const w of spoken.length ? spoken : heard) {
        let words = spokenTracks.get(w.track);
        if (!words) spokenTracks.set(w.track, words = []);
        words.push(w);
      }
    } catch (err) {
      signal.throwIfAborted();
      unavailable.push({ mediaId, reason: (err as Error).message });
    } finally { await store?.close(); recording?.release(); }
  }
  const lanes = [...tracks.values()], byTime = (a: Heard, b: Heard) => a.start - b.start;
  const repeats = lanes.flatMap(words => repeatedPhrases(words.sort(byTime)));
  // Alternate dialogue tracks may hand off at a cut. Concurrent microphones retain separate readings.
  if (lanes.length > 1) repeats.push(...repeatedPhrases(lanes.flat().sort(byTime), true));
  // The same pair read both ways is one repeat. The speech reading's stands: its words are the ones measured on the sound.
  const near = (a: number, b: number) => Math.abs(a - b) < .3;
  const spokenLanes = [...spokenTracks.values()].map(words => words.sort(byTime));
  for (const lane of spokenLanes) for (const r of restarts(lane)) {
    if (!repeats.some(known => near(known.first.start, r.first.start) && near(known.second.start, r.second.start))) repeats.push(r);
  }
  repeats.sort((a, b) => a.first.start - b.first.start);
  const silences = silencesLeft(spokenLanes.flat().sort(byTime), silencesFrom);
  // Reused footage can play the same pair in two places. A keep applies only to the placement the editor considered.
  const ids = new Set<string>(), reused = new Set<string>();
  for (const r of repeats) {
    if (ids.has(r.id)) reused.add(r.id);
    ids.add(r.id);
  }
  for (const r of repeats) if (reused.has(r.id)) {
    r.id += "-" + createHash("sha256").update(JSON.stringify([r.occurrences.first?.clipId, r.occurrences.second?.clipId, r.first.start])).digest("hex").slice(0, 12);
  }
  // Only the stretches read here meet: a part cut short by the scope ends where the scope does, not at a join.
  const pairs = joinSides(sides).filter(([a, b]) => { const ca = clipById(tl, a.clipId), cb = clipById(tl, b.clipId); return !!ca && !!cb && Math.abs(a.source.end - ca.sourceOut) < 1e-3 && Math.abs(b.source.start - cb.sourceIn) < 1e-3; });
  const joins = pairs.flatMap(([a, b]) => hearJoin(a, b));
  const unheard = new Map<string, { mediaId: string; reason: string; at: Set<number> }>();
  for (const [a, b] of pairs) {
    // Where timeline_join_audit finds the join: a crossfade at the middle of its overlap.
    const at = round(a.timelineEnd > b.timelineStart ? (a.timelineEnd + b.timelineStart) / 2 : b.timelineStart);
    for (const s of [a, b]) if (s.unheard) {
      let entry = unheard.get(s.mediaId);
      if (!entry) unheard.set(s.mediaId, entry = { mediaId: s.mediaId, reason: s.unheard, at: new Set() });
      entry.at.add(at);
    }
  }
  return { version: tl.version, repeats, silences, fragments: dividedSentences(ctx, project, parts, cutToolJoins(ctx, project, tl)), unavailable, joins, unheardJoins: [...unheard.values()] };
}
