import type { TimeRange } from "@scarlet/timeline";

export interface ProgressFocus {
  /** The stretch of the video the line zooms to. */
  view: TimeRange;
  /** What the change touches: removed footage, or the edited passage. */
  band?: TimeRange;
  bandLabel?: string;
  /**
   * Removed footage is hatched red (the default). `kept`: the footage stays in the edit (a sound fix, a zoom, a title), so After
   * plays it and it’s only outlined. `added`: footage an edit put back. `proposed`: a call's cut, still in the video until
   * the editor approves it, so it is drawn as removed footage with a dashed edge.
   */
  tone?: "kept" | "added" | "check" | "proposed";
  /** The editor rejected the edit a moment ago: its band fades where it is, and takes no press meanwhile. */
  leaving?: boolean;
}

/** Above this share of the video a band says nothing about where the change is, so the line stays whole. */
const MOST_OF_THE_VIDEO = 0.8;

/** The context to show around a change: enough to see what comes before and after it. */
export function focusAround(range: TimeRange, duration: number, bandLabel?: string,
  { tone, playbackEnd }: { tone?: ProgressFocus["tone"]; playbackEnd?: number } = {}): ProgressFocus | undefined {
  if (duration > 0 && range.end - range.start >= duration * MOST_OF_THE_VIDEO) return undefined;
  // Center the band with room past the last played frame, including any neighboring cuts the audition skips.
  const pad = Math.max(5, (range.end - range.start) * 0.15, (playbackEnd ?? range.end) - range.end + 2);
  return {
    view: { start: Math.max(0, range.start - pad), end: Math.min(duration || range.end + pad, range.end + pad) },
    band: range, bandLabel, tone,
  };
}
