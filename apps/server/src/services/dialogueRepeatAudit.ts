import { createHash } from "node:crypto";
import { fileInDirectory } from "@scarlet/render";
import { clipEnd, mergeRanges, timelineToSource, type MediaClip, type Project, type Timeline, type TimeRange } from "@scarlet/timeline";
import { adjacentRepeatCandidates, cutAnchorOn, normalizeTranscriptToken, type JoinHearing, type Task } from "@scarlet/shared";
import type { Ctx } from "../context.js";
import { acousticWordReader } from "../transcribe/acousticWords.js";
import { EmissionFile } from "../transcribe/emissions.js";
import { alignsLanguage, measureRecordingWords } from "../transcribe/wordAlign.js";
import { transcriptLanguage } from "./transcriptReader.js";
import { dialogueDetector } from "./dialogueDetections.js";
import { emissionStore, recordingWav, type RecordingAudio } from "./recordingAudio.js";

interface Word extends TimeRange { text: string }
interface Placement { track: string; clip: MediaClip; source: TimeRange }
interface Heard extends Word { mediaId: string; source: number; sourceEnd: number; clip: string; track: string; clipStart: number; clipEnd: number }
const round = (n: number) => Math.round(n * 1000) / 1000;
const span = (words: Heard[]) => ({ start: round(words[0]!.start), end: round(words.at(-1)!.end) });

/** One side of a join as heard: a played stretch of a recording, its words read from the sound and its transcript words. */
export interface JoinSide { mediaId: string; clipId: string; trackId: string; timelineStart: number; timelineEnd: number; source: TimeRange; heard: Word[]; said: Word[] }

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
        found.push({ at, mediaId: side.mediaId, side: which, issue: "fragment", heard: edgeWord.text, ...(word && { expected: word.text }), source: Math.round(edgeWord.start * 1000) / 1000 });
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
  const audible = new Set(project.media.filter(m => m.kind === "audio" || (m.kind === "video" && m.hasAudio !== false)).map(m => m.id));
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

function clipById(tl: Timeline, id: string) {
  for (const t of tl.tracks) for (const c of t.clips) if (c.id === id && c.kind === "media") return c;
}

/** Read each audible source separately so two live microphones never form a spurious repeated word together. */
export async function auditDialogueAudio(ctx: Ctx, project: Project, tl: Timeline, task: Task, signal: AbortSignal) {
  const scope = task.context;
  const current = placements(project, tl);
  const base = scope.version && scope.version !== tl.version && scope.time !== undefined && scope.end !== undefined
    ? ctx.repos.versions.get(project.id, scope.version)?.timeline : undefined;
  const parts = inScope(current, base ? placements(project, base) : current, scope, cutAnchorOn(scope, tl, base));
  const tracks = new Map<string, Heard[]>();
  const unavailable: Array<{ mediaId: string; reason: string }> = [];
  const sides: JoinSide[] = [];
  for (const mediaId of new Set(parts.map(p => p.clip.mediaId))) {
    signal.throwIfAborted();
    const media = project.media.find(m => m.id === mediaId)!;
    const selected = parts.filter(p => p.clip.mediaId === mediaId);
    let store: EmissionFile | null = null, recording: RecordingAudio | undefined;
    const heard: Heard[] = [];
    try {
      const file = fileInDirectory(ctx.paths.media(project.id), media.path);
      if (!file) throw new Error("The source recording is unavailable.");
      const language = transcriptLanguage(ctx, project.id, media);
      const add = (p: Placement, w: Word) => {
        const { source, track, clip } = p;
        const at = (s: number) => clip.timelineIn + (s - clip.sourceIn) / clip.speed;
        const text = normalizeTranscriptToken(w.text);
        if (text) heard.push({ text, source: Math.max(source.start, w.start), sourceEnd: Math.min(source.end, w.end), mediaId, track, clip: clip.id, clipStart: clip.timelineIn, clipEnd: clipEnd(clip),
          start: at(Math.max(w.start, source.start)), end: at(Math.min(w.end, source.end)) });
      };
      const lang = language || ctx.settings().transcription.language;
      if (lang && lang !== "auto" && !alignsLanguage(lang)) {
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
        for (const part of selected) {
          const [lo, hi] = store.frameRange(part.source.start, part.source.end);
          const reader = acousticWordReader();
          for (let f = lo; f < hi; f += 3000) {
            signal.throwIfAborted();
            reader.read(await store.read(f, Math.min(f + 3000, hi)), f);
          }
          const read = reader.finish();
          for (const word of read) add(part, word);
          const { clip } = part;
          const at = (t: number) => clip.timelineIn + (t - clip.sourceIn) / clip.speed;
          sides.push({ mediaId, clipId: clip.id, trackId: part.track, timelineStart: at(part.source.start), timelineEnd: at(part.source.end), source: part.source,
            heard: read, said: said.filter(w => w.end > part.source.start - 1 && w.start < part.source.end + 1) });
        }
      }
      for (const w of heard) {
        let words = tracks.get(w.track);
        if (!words) tracks.set(w.track, words = []);
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
  repeats.sort((a, b) => a.first.start - b.first.start);
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
  const joins = joinSides(sides).filter(([a, b]) => { const ca = clipById(tl, a.clipId), cb = clipById(tl, b.clipId); return !!ca && !!cb && Math.abs(a.source.end - ca.sourceOut) < 1e-3 && Math.abs(b.source.start - cb.sourceIn) < 1e-3; })
    .flatMap(([a, b]) => hearJoin(a, b));
  return { version: tl.version, repeats, unavailable, joins };
}
