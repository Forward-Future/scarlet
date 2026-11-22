/**
 * Kept-word verification across dialogue joins: nearby word projection, doubled
 * words, pickup repeats, partial-word repeats, and resume-quote checking.
 */
import { applyReviewRemovals, clipDuration, crossfadeJoins, sourceToTimeline, timelineToSource, type MediaAsset, type Project, type TimeRange, type Timeline } from "@scarlet/timeline";
import { JOIN_WORD_SECONDS, normalizeTranscriptToken } from "@scarlet/shared";
import { audibleClipsByTrack, isTag, round3 } from "./analysis.js";
import { SPEECH_DBFS, atQuietOrDip, dialogueAudioStream, extremeLevel, pageAt, plain, wordMargin, type JoinPage, type Word } from "./dialogue-acoustics.js";
import { partialRepeatAtJoin, type FragmentSide } from "./dialogue-fragment-repeat.js";
import { REPEAT_WITHIN } from "./dialogue-leftovers.js";
import { MAX_CROSSFADE, timelineJoins, type JoinSide } from "./timeline-perception.js";

export function dialogueClips(tl: Timeline, project: Pick<Project, "media">) {
  const streams = new Map(project.media.filter(m => m.kind === "audio" || m.hasAudio).map(m =>
    [m.id, dialogueAudioStream(m) ?? 0] as const));
  return { clips: audibleClipsByTrack(tl).flat().filter(c => streams.has(c.mediaId)), streams };
}

/** Exact timeline word edges from the same scan that judges the join. */
export function dialogueJoinWords(tl: Timeline, project: Pick<Project, "media">, range: TimeRange, pages: JoinPage[]) {
  const { clips, streams } = dialogueClips(tl, project);
  const wordsAt = (at: number) => clips.flatMap(clip => {
    if (at < clip.timelineIn || at > clip.timelineIn + clipDuration(clip)) return [];
    const t = timelineToSource(clip, at);
    const stream = dialogueAudioStream(clip) ?? streams.get(clip.mediaId);
    const page = pageAt(pages, clip.mediaId, stream, t);
    const words = page?.words.filter(w => w.end > t - JOIN_WORD_SECONDS && w.start < t + JOIN_WORD_SECONDS && w.start >= clip.sourceIn && w.end <= clip.sourceOut);
    if (!words?.length) return [];
    const timelineAt = (source: number) => sourceToTimeline(clip, source);
    return [{ mediaId: clip.mediaId, clipId: clip.id, ...(stream && { audioStream: stream }), words: words.map(w => [timelineAt(w.start), timelineAt(w.end), w.text] as const) }];
  });
  return { start: wordsAt(range.start), end: wordsAt(range.end) };
}

type TimedWord = readonly [start: number, end: number, text: string];
type NearbyWords = ReturnType<typeof dialogueJoinWords>;
type RepeatReadings = { start: Pick<NearbyWords["start"][number], "mediaId" | "audioStream" | "words">[];
  end: Pick<NearbyWords["end"][number], "mediaId" | "audioStream" | "words">[] };
interface JoinRepeat { mediaId: string; words: string; before: TimeRange; after: TimeRange }
interface PickupRepeat { mediaId: string; words: string; side: "start" | "end"; first: TimeRange; second: TimeRange }

function samePhrase(left: TimedWord[], right: TimedWord[], removedSeconds = 0) {
  const gap = right[0]![0] - left.at(-1)![1] - removedSeconds;
  if (gap < -2 * wordMargin || gap >= REPEAT_WITHIN) return;
  if (!left.every((w, i) => {
    const token = normalizeTranscriptToken(w[2]);
    return token && token === normalizeTranscriptToken(right[i]![2]);
  })) return;
  const span = (words: TimedWord[]) => ({ start: round3(words[0]![0]), end: round3(words.at(-1)![1]) });
  return { words: left.map(w => plain({ text: w[2] })).join(" "), first: span(left), second: span(right) };
}

/** Words doubled across an edit, or an immediately repeated phrase at the beginning or end of a kept take. */
function dialogueJoinRepeats(nearby: RepeatReadings, cut: TimeRange, previousEnd = 0, nextStart = Infinity) {
  const kept = (readings: RepeatReadings["start"], side: "start" | "end") => readings.map(r => ({
    ...r, words: r.words.filter(([s, e]) => side === "start"
      ? s >= previousEnd && (s + e) / 2 < cut.start : (s + e) / 2 >= cut.end && e <= nextStart),
  })).filter(r => r.words.length && (side === "start" ? r.words.at(-1)![1] <= cut.start + wordMargin : r.words[0]![0] >= cut.end - wordMargin));
  const before = kept(nearby.start, "start"), after = kept(nearby.end, "end");
  let repeatAtJoin: JoinRepeat | undefined;
  for (const out of before) {
    for (const incoming of after) {
      if (repeatAtJoin || incoming.mediaId !== out.mediaId || incoming.audioStream !== out.audioStream) continue;
      for (let n = Math.min(out.words.length, incoming.words.length); n > 0; n--) {
        const match = samePhrase(out.words.slice(-n), incoming.words.slice(0, n), cut.end - cut.start);
        if (match) { repeatAtJoin = { mediaId: out.mediaId, words: match.words, before: match.first, after: match.second }; break; }
      }
    }
  }
  const pickupRepeats: PickupRepeat[] = [];
  for (const [side, readings] of [["start", before], ["end", after]] as const) {
    for (const { mediaId, words } of readings) {
      // A pickup belongs to this cut when it opens or closes the take, within one second of its edge.
      if ((side === "start" ? cut.start - words.at(-1)![1] : words[0]![0] - cut.end) > 1) continue;
      for (let n = Math.floor(words.length / 2); n >= 1; n--) {
        const pair = side === "start" ? words.slice(-2 * n) : words.slice(0, 2 * n);
        const match = samePhrase(pair.slice(0, n), pair.slice(n));
        if (match) { pickupRepeats.push({ mediaId, side, ...match }); break; }
      }
    }
  }
  return { repeatAtJoin, pickupRepeats };
}

export type ReadKeptWords = (mediaId: string, stream: number | undefined, from: number, to: number, cachedOnly?: true) => Promise<Word[]>;
/**
 * A `cachedOnly` read found no reading to answer from, as for a language the aligner has no model for. Nothing failed:
 * the check that wanted it, the partial-word check, doesn't run.
 */
export class NoCachedSpeech extends Error {}

/** Use the engine's ripple and fade operations so unavailable handles and existing edits are respected. */
export function dialogueCutPreview(tl: Timeline, media: MediaAsset[], ranges: TimeRange[], fadeSeconds: number) {
  const straight = applyReviewRemovals(tl, ranges, "join");
  let removed = 0;
  const joins = ranges.map(r => {
    const at = r.start - removed;
    removed += r.end - r.start;
    return at;
  });
  return crossfadeJoins(straight, media, joins, fadeSeconds).timeline;
}

type JoinPlayback = { preview: () => Timeline; at: number; partialOnly?: boolean };

/** Read the real handles only for a join whose aligned words could put the same word on both sides. */
async function checkPartialWord(tl: Timeline, project: Pick<Project, "media">, cut: TimeRange, nearby: NearbyWords,
  read: ReadKeptWords, playback: JoinPlayback, previousEnd: number, nextStart: number) {
  // A physical edge may sit half an overlap beyond the picture cut. Avoid building a preview for unrelated words.
  const handle = MAX_CROSSFADE / 2;
  const plausible = nearby.start.some(left => nearby.end.some(right => {
    if (left.mediaId !== right.mediaId || left.audioStream !== right.audioStream) return false;
    const outgoing = left.words.filter(([s, e]) => s < cut.start + handle && e > cut.start - REPEAT_WITHIN);
    const incoming = right.words.filter(([s, e]) => s < cut.end + REPEAT_WITHIN && e > cut.end - handle);
    return outgoing.some(a => incoming.some(b =>
      (a[1] >= cut.start || b[0] <= cut.end) && normalizeTranscriptToken(a[2]) === normalizeTranscriptToken(b[2])));
  }));
  if (!plausible) return;
  const preview = playback.preview();
  const join = timelineJoins(preview).find(j => Math.abs(j.at - playback.at) < .001);
  if (!join) return;
  const originals = new Map(dialogueClips(tl, project).clips.map(c => [c.id, c]));
  for (const track of join.tracks) {
    if (track.gap || track.out.mediaId !== track.in.mediaId) continue;
    const clips = preview.tracks.find(t => t.id === track.trackId)!.clips;
    const side = async (which: "start" | "end", played: JoinSide): Promise<FragmentSide | undefined> => {
      const out = which === "start", at = cut[which];
      const clip = clips.find(c => c.id === played.clipId);
      if (clip?.kind !== "media") return;
      const asset = project.media.find(m => m.id === clip.mediaId);
      if (!asset) return;
      const stream = dialogueAudioStream(clip) ?? dialogueAudioStream(asset);
      // Scan words describe the asset's selected stream. A different clip override needs its own transcript.
      if (stream !== dialogueAudioStream(asset)) return;
      const centerSource = timelineToSource(clip, playback.at);
      // Match by placement as well as recording. A ripple can split a clip, and a fade can move its sound to another track.
      const candidates = nearby[which].filter(r => r.mediaId === played.mediaId).flatMap(r => {
        const before = originals.get(r.clipId);
        if (!before || before.speed !== clip.speed || (dialogueAudioStream(before) ?? dialogueAudioStream(asset)) !== stream ||
          Math.abs(timelineToSource(before, at) - centerSource) > 1e-5) return [];
        return [{ before, scan: r.words }];
      });
      if (candidates.length !== 1) return;
      const { before, scan } = candidates[0]!;
      const clock = (source: number) => at + (source - centerSource) / clip.speed;
      const edge = clock(played.source);
      const from = out ? Math.max(clip.sourceIn, played.source - JOIN_WORD_SECONDS,
        centerSource + (previousEnd - at) * clip.speed) : played.source;
      const to = out ? played.source : Math.min(clip.sourceOut, played.source + JOIN_WORD_SECONDS,
        centerSource + (nextStart - at) * clip.speed);
      if (to <= from) return;
      const words = await read(clip.mediaId, stream, from, to, true).catch(err => {
        if (err instanceof NoCachedSpeech) return undefined;
        throw err;
      });
      if (!words) return;
      const heard = words.filter(w => w.end > w.start && !isTag(w.text)).map(w => [clock(w.start), clock(w.end), w.text] as const);
      return { trackId: track.trackId, clipId: before.id, mediaId: clip.mediaId, audioStream: stream, speed: clip.speed,
        sourceAtEdge: played.source, edge, bounds: { start: clock(from), end: clock(to) }, scan, heard };
    };
    const [out, incoming] = await Promise.all([side("start", track.out), side("end", track.in)]);
    if (out && incoming) {
      const found = partialRepeatAtJoin(cut, out, incoming);
      if (found) return found;
    }
  }
}

/** Read the two pieces that would play, clipping the listening windows at adjacent removals and source clip edges. */
export async function checkKeptWords(tl: Timeline, project: Pick<Project, "media">, cut: TimeRange, nearby: NearbyWords,
  read?: ReadKeptWords, previousEnd = 0, nextStart = Infinity, playback?: JoinPlayback) {
  // A join staged for the editor is still read for a phrase it plays twice: the call reaches them as that join.
  const repeats = dialogueJoinRepeats(nearby, cut, previousEnd, nextStart);
  const scan = playback?.partialOnly ? { repeatAtJoin: repeats.repeatAtJoin, pickupRepeats: [] } : repeats;
  const unread = new Set<string>();
  if (!read) return { ...scan, partialWordRepeat: undefined, unread: [...unread] };
  const readWindow: ReadKeptWords = async (id, stream, from, to, cachedOnly) => {
    try { return await read(id, stream, from, to, cachedOnly); }
    catch (err) {
      if (cachedOnly && err instanceof NoCachedSpeech) throw err;
      unread.add(id + ": " + (err instanceof Error ? err.message : String(err)));
      return [];
    }
  };
  const partial = playback && checkPartialWord(tl, project, cut, nearby, readWindow, playback, previousEnd, nextStart);
  if (playback?.partialOnly) return { ...scan, partialWordRepeat: await partial, unread: [...unread] };
  const { clips } = dialogueClips(tl, project);
  const side = async (which: "start" | "end") => {
    const at = cut[which], out = which === "start";
    const audible = clips.filter(clip => {
      const lo = clip.timelineIn, hi = lo + clipDuration(clip);
      return out ? lo < at && at <= hi : lo <= at && at < hi;
    });
    return Promise.all(audible.map(async clip => {
      const lo = clip.timelineIn, hi = lo + clipDuration(clip), edge = timelineToSource(clip, at);
      const from = out ? Math.max(edge - JOIN_WORD_SECONDS, timelineToSource(clip, Math.max(previousEnd, lo))) : edge;
      const to = out ? edge : Math.min(edge + JOIN_WORD_SECONDS, timelineToSource(clip, Math.min(nextStart, hi)));
      const asset = project.media.find(m => m.id === clip.mediaId)!;
      const stream = dialogueAudioStream(clip) ?? dialogueAudioStream(asset);
      const words = to > from + 1e-6 ? await readWindow(clip.mediaId, stream, from, to) : [];
      return { mediaId: clip.mediaId, ...(stream && { audioStream: stream }),
        words: words.filter(w => w.start >= from - 1e-6 && w.end <= to + 1e-6 && w.end > w.start && normalizeTranscriptToken(w.text) && !isTag(w.text))
          .map(w => [sourceToTimeline(clip, w.start), sourceToTimeline(clip, w.end), w.text] as const) };
    }));
  };
  const [start, end, partialWordRepeat] = await Promise.all([side("start"), side("end"), partial]);
  const heard = dialogueJoinRepeats({ start, end }, cut, previousEnd, nextStart);
  // Both are readings of the same take. Give the agent the scan's spelling when both find its repeat.
  const pickupRepeats = [...scan.pickupRepeats];
  for (const p of heard.pickupRepeats) {
    if (!pickupRepeats.some(s => s.mediaId === p.mediaId && s.side === p.side &&
      s.first.start < p.second.end && p.first.start < s.second.end)) pickupRepeats.push(p);
  }
  return { repeatAtJoin: scan.repeatAtJoin ?? heard.repeatAtJoin, pickupRepeats, partialWordRepeat, unread: [...unread] };
}

/** Check the start of the chosen delivery, including the continuation that distinguishes it from a rehearsal. */
export function checkResumeQuote(tl: Timeline, project: Project, end: number, pages: JoinPage[], quote: string) {
  const { clips, streams } = dialogueClips(tl, project);
  const tokens = (s: string) => s.split(/\s+/u).map(normalizeTranscriptToken).filter(Boolean);
  const expected = tokens(quote);
  if (!expected.length) return "unverified";
  let matched = false;
  for (const clip of clips) {
    if (end < clip.timelineIn || end >= clip.timelineIn + clipDuration(clip)) continue;
    const t = timelineToSource(clip, end);
    const page = pageAt(pages, clip.mediaId, dialogueAudioStream(clip) ?? streams.get(clip.mediaId), t);
    if (!page) return "unverified";
    const resumingAtDip = atQuietOrDip(page, t);
    const words = page.words.filter(w => {
      if (w.end <= t || w.end > clip.sourceOut) return false;
      if (w.start >= t - wordMargin) return true;
      // A scan page can omit an abandoned syllable and stretch the resuming word backward across a
      // measured dip or quiet point. When the edge sits at that dip and the word still sounds at
      // speaking level after it, that word is what resumes there (2026-11-22).
      return resumingAtDip && w.end > t + wordMargin &&
        (extremeLevel(page, t, w.end, "highest")?.db ?? -Infinity) > SPEECH_DBFS;
    });
    if (!words.length) return "unverified";
    const heard = words.slice(0, expected.length).flatMap(w => tokens(w.text));
    if (heard.some((word, i) => i < expected.length && expected[i] !== word)) return "different";
    if (heard.length < expected.length) return "unverified";
    matched = true;
  }
  return matched ? "matches" : "unverified";
}
