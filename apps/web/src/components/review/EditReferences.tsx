import type { Change, TimeRange } from "@scarlet/timeline";
import type { IconName } from "../ui/primitives";

export type EditMarker = { time: number; description: string; icon: IconName };
export type EditCue = EditMarker & { changeId: string; spot: number };

export function editIcon(change: Change, text: string): IconName {
  if (change.firstCut || change.appliedReview) return "trim";
  if (change.ops?.length && change.ops.every(op => op.op === "rippleDelete" || op.op === "splitClip")) return "trim";
  if (/\b(?:captions?|captioned|subtitles?)\b/i.test(text)) return "captions";
  if (/\b(?:volumes?|gain|audio|music|levels?|leveled|levelled|leveling|levelling|loudness|louder|quieter|crossfades?)\b/i.test(text)) return "audio";
  if (/\b(?:cut|cuts|trim|trimmed|pause|ripple|filler)\b/i.test(text)) return "trim";
  return "film";
}

const timecode = /\b(?:\d+:)?\d+:[0-5]\d(?:\.\d+)?\b/g;

/** Resolve named moments against this version's ranges, excluding runtimes and ambiguous matches. */
export function editMoments(text: string, ranges: TimeRange[]) {
  return Array.from(text.matchAll(timecode)).flatMap(match => {
    const stamp = match[0];
    const before = text.slice(0, match.index);
    const after = text.slice(match.index + stamp.length);
    if (/\b(?:runs|duration|runtime|running time)(?:\s+(?:is|of))?[:\s]*$/i.test(before)
      || /^\s+(?:long|in length|in total)\b/i.test(after)) return [];
    const time = stamp.split(":").reduce((seconds, field) => seconds * 60 + Number(field), 0);
    const precision = 10 ** -(stamp.split(".")[1]?.length ?? 0);
    const matches = ranges.flatMap((range, index) => range.start < time + precision && range.end >= time ? [index] : []);
    if (matches.length !== 1) return [];
    const spot = matches[0]!;
    return [{ index: match.index, spot, time: Math.max(time, ranges[spot]!.start), label: stamp, cue: /\b(?:at|near|around)\s*$/i.test(before) }];
  });
}
