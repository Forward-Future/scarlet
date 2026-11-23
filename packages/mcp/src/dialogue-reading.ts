/**
 * Pure read & quote-checking helpers for dialogue joins and staged-cut notes.
 */
import { normalizeTranscriptToken } from "@scarlet/shared";
import { clipDuration, clipsAt, indexClipsAt, sourceToTimeline, timelineToSource, type Project, type TimeRange, type Timeline, type TranscriptWord } from "@scarlet/timeline";
import { audibleClipsByTrack } from "./analysis.js";

/** Every clip of a recording that sounds on this version, in track and clip order. */
export const audibleClipsInTrackOrder = (tl: Timeline) => audibleClipsByTrack(tl).flat();

/** The transcript words the edit plays within `reach` seconds of a range, and inside it, in playback order. */
export async function timelineWordsNear(tl: Timeline, project: Pick<Project, "media">, range: TimeRange,
  words: (mediaId: string) => Promise<readonly TranscriptWord[] | null>, reach: number) {
  const heard: Array<{ at: number; text: string }> = [];
  for (const clip of audibleClipsInTrackOrder(tl)) {
    const lo = clip.timelineIn, hi = lo + clipDuration(clip);
    if (hi <= range.start - reach || lo >= range.end + reach) continue;
    if (!project.media.some(m => m.id === clip.mediaId && (m.kind === "audio" || m.hasAudio))) continue;
    for (const w of await words(clip.mediaId).catch(() => null) ?? []) {
      const middle = (w.start + w.end) / 2;
      if (middle < clip.sourceIn || middle >= clip.sourceOut || !w.text.trim()) continue;
      const at = sourceToTimeline(clip, middle);
      if (at < range.start - reach || at > range.end + reach) continue;
      // The same recording on two tracks plays each word once.
      if (!heard.some(h => Math.abs(h.at - at) < 1e-3 && h.text === w.text.trim())) heard.push({ at, text: w.text.trim() });
    }
  }
  return heard.sort((a, b) => a.at - b.at);
}

/**
 * The transcript words a join plays either side of a removal, as the viewer hears them: the last few kept before it,
 * ‖ for the cut, and the first few kept after it, across whichever clips play them. A cut that took "it a very simple"
 * out of "I gave it a very simple prompt" read as a restart in the transcript; this is what it plays: "I gave ‖
 * prompt" (2026-11-16).
 */
export async function joinPlays(tl: Timeline, project: Pick<Project, "media">, range: TimeRange,
  words: (mediaId: string) => Promise<readonly TranscriptWord[] | null>, count = 6) {
  return joinText(await timelineWordsNear(tl, project, range, words, 6), range, count);
}

type Heard = ReadonlyArray<{ at: number; text: string }>;

/**
 * What a removal takes out and what its join then plays, as the viewer hears them. A revision placed by seconds on the
 * only span with quiet at both edges took out the whole retake "where you would" and kept the broken first take: the
 * result listed the words at each edge, and nothing said the line now played "a time where would ‖ occasionally see"
 * (2026-11-17).
 */
export async function cutReading(tl: Timeline, project: Pick<Project, "media">, range: TimeRange,
  words: (mediaId: string) => Promise<readonly TranscriptWord[] | null>, inside = 16) {
  const heard = await timelineWordsNear(tl, project, range, words, 6);
  const removed = heard.filter(h => h.at > range.start && h.at < range.end).map(h => h.text);
  const removes = (removed.length > inside ? [...removed.slice(0, inside / 2), "…", ...removed.slice(-inside / 2)] : removed).join(" ");
  const plays = joinText(heard, range);
  return { ...(removes && { removes }), ...(plays && { plays }) };
}

export function joinText(heard: Heard, range: TimeRange, count = 6) {
  const before = heard.filter(h => h.at <= range.start).slice(-count).map(h => h.text);
  const after = heard.filter(h => h.at >= range.end).slice(0, count).map(h => h.text);
  return before.length || after.length ? `${before.length ? "… " + before.join(" ") : ""} ‖ ${after.length ? after.join(" ") + " …" : ""}`.trim() : "";
}

/**
 * The words a removal plays if it is kept: a few either side and the ones it would take out, as the viewer hears them,
 * with the middle of a long passage elided. A held restart's note said only what its join would play, and a pass kept
 * "you can see the rough, you can see the shadows" rather than clip the release of "nice" (2026-11-17).
 */
export function keptText(heard: Heard, range: TimeRange, count = 3, inside = 16) {
  const removed = heard.filter(h => h.at > range.start && h.at < range.end).map(h => h.text);
  if (!removed.length) return "";
  const before = heard.filter(h => h.at <= range.start).slice(-count).map(h => h.text);
  const after = heard.filter(h => h.at >= range.end).slice(0, count).map(h => h.text);
  const middle = removed.length > inside ? [...removed.slice(0, inside / 2), "…", ...removed.slice(-inside / 2)] : removed;
  return `${before.length ? "… " : ""}${[...before, ...middle, ...after].join(" ")}${after.length ? " …" : ""}`;
}

/** How far from a staged cut, in timeline seconds, the words a call's note quotes may start. */
export const NOTE_QUOTE_REACH = 3;
/**
 * Phrases of two words or more a call's note quotes that neither start inside the cut nor within NOTE_QUOTE_REACH of
 * it, where the edit plays them. `heard` is the edit's words near the cut, in playback order. A note is the editor's
 * only account of a call: one pass's note on a cut of "it a very simple" told the editor to keep "the completed ‘is it
 * able to build’ question", a restart four seconds on (2026-11-16).
 */
export function quotesAwayFromCut(note: string, heard: ReadonlyArray<{ at: number; text: string }>, range: TimeRange, reach = NOTE_QUOTE_REACH) {
  const tokens = heard.map(h => ({ at: h.at, token: normalizeTranscriptToken(h.text) })).filter(t => t.token);
  const quoted = [...note.matchAll(/[‘“"]([^‘“"”]+?)[’”"](?=[\s.,;:!?)]|$)/gu)].map(m => m[1]!.trim());
  // What the cut leaves playing: a note that says what the join should sound like quotes words from both sides of
  // it, which are not next to each other until the cut is made. “Listen to ‘a time where you would’” was refused on a
  // cut that plays exactly that (2026-11-17).
  const played = tokens.filter(t => t.at <= range.start || t.at >= range.end);
  return quoted.filter(q => {
    const phrase = q.split(/\s+/u).map(normalizeTranscriptToken).filter(Boolean);
    if (phrase.length < 2) return false;
    return ![tokens, played].some(said => said.some((t, i) => t.at >= range.start - reach && t.at <= range.end + reach &&
      phrase.every((p, k) => said[i + k]?.token === p)));
  });
}

/** Each audible source instant under the given timeline times. */
export function audibleSourcePoints(tl: Timeline, times: number[]) {
  const clips = times.length > 2 ? indexClipsAt(tl) : (time: number) => clipsAt(tl, time);
  return times.flatMap(at => clips(at).flatMap(({ clip, track }) =>
    clip.kind === "media" && !track.muted && clip.enabled && clip.volume > 0 && track.kind !== "caption"
      ? [{ mediaId: clip.mediaId, t: timelineToSource(clip, at) }] : []));
}
