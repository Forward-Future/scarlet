/**
 * Stretches where nobody speaks. A pause is a quiet interior, measured by level and voice activity,
 * so typing, a breath or a cough splits one long wait into slivers and the pause list hides it.
 * A silence here is only the absence of words, with what sounds and what the picture does reported
 * beside it. Scarlet reports; the model decides.
 */
import { clipDuration, rangesOverlap, timelineToSource, type MediaAsset, type MediaClip, type TimeRange, type Timeline, type Transcript, type TranscriptWord } from "@scarlet/timeline";
import type { PictureActivityWindow } from "@scarlet/shared";
import { audibleMediaClips, dbfs, remainingPauseRanges, round3 } from "./analysis.js";
import type { TimelineWord } from "./timeline-perception.js";

/** The scan lists a stretch without words from this length. */
export const SILENCE_SECONDS = 1.5;
/** A saved part reports a stretch without words it still plays from this length. */
export const KEPT_SILENCE_SECONDS = 2;

export interface Silence extends TimeRange {
  seconds: number;
  /** The words either side. One is missing where the stretch runs past the page. */
  after?: string;
  before?: string;
  /** Seconds inside it the voice detector took for voice. No word was transcribed there. */
  voiceSeconds: number;
  maxPeakDb?: number;
  /** The stretch reaches the page's edge and may continue on the next page. */
  open?: "start" | "end" | "both";
}

const spoken = (w: TranscriptWord) => w.end > w.start && !!w.text.trim() && !/^\[.*\]$/.test(w.text.trim());

/** Every stretch of a page with no transcript word for at least `min` seconds. `previous` is the last word before the page. */
export function silences(transcript: Transcript | null, wf: { from: number; to: number; peaks: number[]; speechActivity?: TimeRange[] },
  opts: { min?: number; previous?: TranscriptWord } = {}): Silence[] {
  const min = opts.min ?? SILENCE_SECONDS;
  const words = (transcript?.segments ?? []).filter(s => !/^\[(?:blank_audio|silence)\]$/i.test(s.text.trim()))
    .flatMap(s => s.words).filter(w => spoken(w) && w.end > wf.from && w.start < wf.to).sort((a, b) => a.start - b.start);
  const step = (wf.to - wf.from) / Math.max(1, wf.peaks.length);
  const measure = (start: number, end: number) => {
    const a = Math.max(start, wf.from), b = Math.min(end, wf.to);
    const voiced = (wf.speechActivity ?? []).reduce((sum, v) => sum + Math.max(0, Math.min(b, v.end) - Math.max(a, v.start)), 0);
    let peak = 0;
    for (let i = Math.max(0, Math.ceil((a - wf.from) / step)); i < Math.min(wf.peaks.length, Math.floor((b - wf.from) / step)); i++) peak = Math.max(peak, wf.peaks[i]!);
    return { voiceSeconds: round3(voiced), ...(peak > 0 && { maxPeakDb: dbfs(peak) }) };
  };
  const out: Silence[] = [];
  const add = (start: number, end: number, left?: TranscriptWord, right?: TranscriptWord, open?: Silence["open"]) => {
    if (end - start < min) return;
    out.push({ start: round3(start), end: round3(end), seconds: round3(end - start),
      ...(left && { after: left.text.trim() }), ...(right && { before: right.text.trim() }), ...measure(start, end), ...(open && { open }) });
  };
  const first = words[0];
  if (!first) {
    add(opts.previous ? Math.min(opts.previous.end, wf.from) : wf.from, wf.to, opts.previous, undefined, opts.previous ? "end" : "both");
    return out;
  }
  const lead = opts.previous && spoken(opts.previous) && opts.previous.end <= first.start ? opts.previous : undefined;
  add(lead ? lead.end : wf.from, first.start, lead, first, lead ? undefined : "start");
  // The last word to finish holds the outgoing edge, as in overlapping dialogue.
  let left = first;
  for (const right of words.slice(1)) {
    add(left.end, right.start, left, right);
    if (right.end >= left.end) left = right;
  }
  add(left.end, wf.to, left, undefined, "end");
  return out;
}

export interface PictureWindow { mediaId: string; from: number; to: number;
  /** Add to this window's source seconds to get the scanned recording's. */ shift: number }

const plain = (clip: MediaClip) => (clip.speed ?? 1) === 1;

/**
 * The pictures on screen while a source range of `mediaId` plays on this version, each on its own source clock.
 * A range that was cut, or that crosses a join, has none.
 */
export function pictureWindows(tl: Timeline, media: MediaAsset[], mediaId: string, range: TimeRange): PictureWindow[] {
  const placed = tl.tracks.filter(t => t.kind !== "caption").flatMap(t => t.clips)
    .find((c): c is MediaClip => c.kind === "media" && c.enabled && c.mediaId === mediaId && plain(c) &&
      c.sourceIn <= range.start + 1e-6 && c.sourceOut >= range.end - 1e-6);
  if (!placed) return [];
  const at = placed.timelineIn + range.start - placed.sourceIn, until = at + range.end - range.start;
  const out: PictureWindow[] = [];
  for (const track of tl.tracks) {
    if (track.kind !== "video" || track.hidden) continue;
    for (const clip of track.clips) {
      if (clip.kind !== "media" || !clip.enabled || clip.opacity === 0 || !plain(clip)) continue;
      if (clip.timelineIn > at + 1e-6 || clip.timelineIn + clipDuration(clip) < until - 1e-6) continue;
      const asset = media.find(m => m.id === clip.mediaId);
      if (!asset || asset.kind === "audio" || out.some(w => w.mediaId === clip.mediaId)) continue;
      const from = timelineToSource(clip, at);
      const to = Math.min(round3(from + range.end - range.start), asset.duration ?? Infinity);
      if (to > from) out.push({ mediaId: clip.mediaId, from: round3(from), to, shift: range.start - from });
    }
  }
  return out;
}

/** A measured window as the scan reports it: areas in percent of the frame, times on the scanned recording's clock. */
export function pictureReading(w: PictureActivityWindow, shift: number) {
  const pct = (v: number | undefined) => v === undefined ? undefined : Math.round(v * 10000) / 100;
  const at = (v: number | undefined) => v === undefined ? undefined : round3(v + shift);
  return { mediaId: w.mediaId, changedFrames: w.changedFrames, frames: w.frames,
    ...(w.changedFrames > 0 && { typicalAreaPct: pct(w.typicalArea), largestAreaPct: pct(w.largestArea), largestAt: at(w.largestAt), lastChangeAt: at(w.lastChangeAt) }) };
}

export interface KeptSilence { mediaId: string; source: TimeRange; start: number; end: number; seconds: number; after: string; before: string }

/**
 * Stretches without words that a saved part still plays and no decision covers. `words` are the version's words in
 * playback order inside the part's range; `decided` are its cut, review and keep ranges, all in timeline seconds.
 */
export function keptSilences(tl: Timeline, words: TimelineWord[], decided: TimeRange[], min = KEPT_SILENCE_SECONDS): KeptSilence[] {
  const clips = audibleMediaClips(tl);
  const out: KeptSilence[] = [];
  // A transcript can mark blank audio as a bracketed word. It is not speech.
  const heard = words.filter(w => w.end > w.start && !/^\[.*\]$/.test(w.text));
  let left = heard[0];
  for (const right of heard.slice(1)) {
    const gap = { start: left!.end, end: right.start };
    if (gap.end - gap.start >= min) {
      for (const piece of remainingPauseRanges(gap, decided.filter(d => rangesOverlap(d, gap)))) {
        if (piece.end - piece.start < min) continue;
        // One recording carries the stretch: the same clip plays at both ends.
        const clip = clips.find(c => c.timelineIn <= piece.start + 1e-6 && c.timelineIn + clipDuration(c) >= piece.end - 1e-6);
        if (!clip) continue;
        out.push({ mediaId: clip.mediaId, source: { start: round3(timelineToSource(clip, piece.start)), end: round3(timelineToSource(clip, piece.end)) },
          start: round3(piece.start), end: round3(piece.end), seconds: round3(piece.end - piece.start), after: left!.text, before: right.text });
      }
    }
    if (right.end >= left!.end) left = right;
  }
  return out;
}
