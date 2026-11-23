/**
 * SubRip (.srt) and WebVTT (.vtt) export. Cue times are the clip's timelineIn /
 * timelineOut, written to the millisecond. Cue text is the clip's plain text;
 * karaoke word spans and caption style (including uppercase) are left out.
 */
import type { Timeline, Track } from "./timelineSchema.js";

export type CaptionExportFormat = "srt" | "vtt";

export interface CaptionExportOptions {
  /** When omitted, the first caption track that is not hidden. */
  trackId?: string;
  /** Overlapping cues are clipped to this range and shifted so 0 is range.start. */
  range?: { start: number; end: number };
}

export type CaptionExportErrorCode =
  | "no_caption_track"
  | "track_not_found"
  | "track_hidden"
  | "not_caption_track"
  | "no_captions_in_range"
  | "bad_range";

export class CaptionExportError extends Error {
  constructor(
    message: string,
    public readonly code: CaptionExportErrorCode,
  ) {
    super(message);
    this.name = "CaptionExportError";
  }
}

interface Cue {
  start: number;
  end: number;
  text: string;
}

export const NO_CAPTION_TRACK = "There’s no caption track to export. Ask Scarlet to add captions, then export again.";
export const NO_CAPTIONS_IN_RANGE = "There are no captions in this range.";
const TRACK_NOT_FOUND = "That caption track isn’t in this version.";
const NOT_CAPTION_TRACK = "That track isn’t captions.";
const TRACK_HIDDEN = "That caption track is hidden. Show it, then export again.";
const BAD_RANGE_START = "Range start must be at least 0.";
const BAD_RANGE_ORDER = "Range end must be after its start.";

function captionExportTrack(timeline: Timeline, trackId?: string): Track {
  if (trackId) {
    const track = timeline.tracks.find(t => t.id === trackId);
    if (!track) throw new CaptionExportError(TRACK_NOT_FOUND, "track_not_found");
    if (track.kind !== "caption") throw new CaptionExportError(NOT_CAPTION_TRACK, "not_caption_track");
    if (track.hidden) throw new CaptionExportError(TRACK_HIDDEN, "track_hidden");
    return track;
  }
  const track = timeline.tracks.find(t => t.kind === "caption" && !t.hidden);
  if (!track) throw new CaptionExportError(NO_CAPTION_TRACK, "no_caption_track");
  return track;
}

/** A custom export range from optional start/end query values. */
export function captionExportRange(start?: number, end?: number): { start: number; end: number } | undefined {
  if (start !== undefined && start < 0) throw new CaptionExportError(BAD_RANGE_START, "bad_range");
  if (start === undefined && end === undefined) return undefined;
  const range = { start: start ?? 0, end: end ?? Number.POSITIVE_INFINITY };
  if (!(range.end > range.start)) throw new CaptionExportError(BAD_RANGE_ORDER, "bad_range");
  return range;
}

export function captionExportHttpStatus(code: CaptionExportErrorCode): 400 | 404 {
  return code === "no_caption_track" || code === "track_not_found" || code === "track_hidden" ? 404 : 400;
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

function captionMillis(seconds: number): number {
  return Math.max(0, Math.round(seconds * 1000));
}

export function formatCaptionTime(seconds: number, decimal: "," | "."): string {
  const total = captionMillis(seconds);
  const hours = Math.floor(total / 3_600_000);
  const minutes = Math.floor((total % 3_600_000) / 60_000);
  const secs = Math.floor((total % 60_000) / 1000);
  const millis = total % 1000;
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(secs, 2)}${decimal}${pad(millis, 3)}`;
}

/**
 * Keep multi-line cues, but drop blank or whitespace-only lines: either one ends a SubRip or WebVTT cue early. A `-->`
 * in the text reads as a timing line in both formats, so it is written as an arrow.
 */
function cueText(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/-->/g, "→").split("\n").filter(line => line.trim()).join("\n");
}

function escapeVtt(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function cuesOn(track: Track, range?: { start: number; end: number }): Cue[] {
  const cues: Cue[] = [];
  for (const clip of track.clips) {
    if (clip.kind !== "caption" || clip.enabled === false) continue;
    const text = cueText(clip.text);
    if (!text.trim()) continue;
    let start = clip.timelineIn;
    let end = clip.timelineOut;
    if (end <= start) continue;
    if (range) {
      start = Math.max(start, range.start);
      end = Math.min(end, range.end);
      if (end <= start) continue;
      start -= range.start;
      end -= range.start;
    }
    if (captionMillis(end) <= captionMillis(start)) continue;
    cues.push({ start, end, text });
  }
  cues.sort((a, b) => a.start - b.start);
  return cues;
}

function exportCues(timeline: Timeline, opts: CaptionExportOptions = {}): Cue[] {
  const cues = cuesOn(captionExportTrack(timeline, opts.trackId), opts.range);
  if (!cues.length) throw new CaptionExportError(NO_CAPTIONS_IN_RANGE, "no_captions_in_range");
  return cues;
}

/** Whether the chosen track has at least one cue to write in this range. */
export function captionExportHasCues(timeline: Timeline, opts: CaptionExportOptions = {}): boolean {
  return cuesOn(captionExportTrack(timeline, opts.trackId), opts.range).length > 0;
}

function cueBlock(cue: Cue, vtt: boolean): string {
  const decimal = vtt ? "." : ",";
  return `${formatCaptionTime(cue.start, decimal)} --> ${formatCaptionTime(cue.end, decimal)}\n${vtt ? escapeVtt(cue.text) : cue.text}`;
}

export function timelineToSrt(timeline: Timeline, opts: CaptionExportOptions = {}): string {
  return exportCues(timeline, opts).map((cue, i) => `${i + 1}\n${cueBlock(cue, false)}`).join("\n\n") + "\n";
}

export function timelineToVtt(timeline: Timeline, opts: CaptionExportOptions = {}): string {
  return `WEBVTT\n\n${exportCues(timeline, opts).map(cue => cueBlock(cue, true)).join("\n\n")}\n`;
}

export function toCaptions(timeline: Timeline, format: CaptionExportFormat, opts: CaptionExportOptions = {}): string {
  return format === "srt" ? timelineToSrt(timeline, opts) : timelineToVtt(timeline, opts);
}
