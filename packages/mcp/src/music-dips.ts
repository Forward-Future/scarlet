import {
  applyOps,
  clipEnd,
  dipKeyframes,
  findClipLocation,
  type ProposeOp,
  type Timeline,
  type TimelineOp,
  type TimeRange,
} from "@scarlet/timeline";
import { round3 } from "./analysis.js";

/** The stock skill music-under-speech's dip, for each field a duckUnderSpeech step leaves out. */
export const DIP_DEFAULTS = { depthDb: -18, fadeDown: 0.3, fadeUp: 0.8, minGap: 2 } as const;

type Duck = Extract<ProposeOp, { op: "duckUnderSpeech" }>;
/** Timeline seconds where someone speaks on the timeline given, on any recording but the ones named. */
export type SpeechOn = (timeline: Timeline, except: ReadonlySet<string>) => Promise<TimeRange[]>;

/** What one duckUnderSpeech step placed, for the model: each dip, and the speech still over the clip at its level. */
export interface DipReport {
  clipId: string;
  under: "speech" | "ranges";
  depthDb: number;
  dips: TimeRange[];
  moreDips?: number;
  speechNotUnder?: TimeRange[];
  moreSpeechNotUnder?: number;
}

/**
 * One duckUnderSpeech step as the updateClip that sets its clip's volumeKeyframes, on the timeline the steps before it
 * leave. The dips take the place of the clip's earlier keyframes. Speech closer than `minGap` shares a dip, so the level
 * comes back up only in longer pauses.
 */
export function dipStep(on: Timeline, step: Duck, words: readonly TimeRange[]): { op: TimelineOp; report: DipReport } {
  const found = findClipLocation(on, step.clipId);
  if (!found || found.clip.kind !== "media") throw new Error(`duckUnderSpeech: no media clip ${step.clipId} on the timeline.`);
  const clip = found.clip;
  const shape = { depth: step.depthDb ?? DIP_DEFAULTS.depthDb, down: step.fadeDown ?? DIP_DEFAULTS.fadeDown, up: step.fadeUp ?? DIP_DEFAULTS.fadeUp };
  const gap = step.minGap ?? DIP_DEFAULTS.minGap;
  const ranges = step.ranges?.map(([start, end]) => {
    if (!(end! > start!)) throw new Error(`duckUnderSpeech ${step.clipId}: each range must be [start, end] with end after start.`);
    return { start: start!, end: end! };
  });
  if (!ranges && !words.length) throw new Error(`duckUnderSpeech ${step.clipId}: no transcribed speech plays on the other clips; give ranges to dip under.`);
  const speech = [...words].sort((a, b) => a.start - b.start).reduce<TimeRange[]>((runs, w) => {
    const last = runs.at(-1);
    if (last && w.start - last.end < gap) last.end = Math.max(last.end, w.end);
    else runs.push({ start: w.start, end: w.end });
    return runs;
  }, []);
  const { keys, dips } = dipKeyframes(clip, ranges ?? speech, shape);
  const start = clip.timelineIn, end = clipEnd(clip);
  // Speech over the clip with no dip under it: evidence for the model, which decides what to do about it.
  const open = speech.filter(s => s.end > start && s.start < end).flatMap(s => {
    let parts = [{ start: Math.max(s.start, start), end: Math.min(s.end, end) }];
    for (const d of dips) parts = parts.flatMap(p => d.end <= p.start || d.start >= p.end ? [p]
      : [{ start: p.start, end: d.start }, { start: d.end, end: p.end }].filter(q => q.end - q.start > 0.05));
    return parts;
  });
  const at = (r: TimeRange) => ({ start: round3(r.start), end: round3(r.end) });
  return {
    op: { op: "updateClip", clipId: clip.id, patch: { volumeKeyframes: keys } },
    report: { clipId: clip.id, under: ranges ? "ranges" : "speech", depthDb: shape.depth, dips: dips.slice(0, 40).map(at),
      ...(dips.length > 40 && { moreDips: dips.length - 40 }),
      ...(open.length && { speechNotUnder: open.slice(0, 20).map(at), ...(open.length > 20 && { moreSpeechNotUnder: open.length - 20 }) }) },
  };
}

/**
 * A proposal's steps with each duckUnderSpeech made into the updateClip it stands for, placed on the timeline the steps
 * before it leave, so music added in the same proposal can be dipped. The stored change holds only timeline ops.
 */
export async function expandDips(steps: ProposeOp[], before: Timeline, speechOn: SpeechOn): Promise<{ ops: TimelineOp[]; dips: DipReport[] }> {
  if (!steps.some(s => s.op === "duckUnderSpeech")) return { ops: steps as TimelineOp[], dips: [] };
  const ops: TimelineOp[] = [], dips: DipReport[] = [];
  let on = before;
  for (const step of steps) {
    let op: TimelineOp;
    if (step.op === "duckUnderSpeech") {
      const found = findClipLocation(on, step.clipId);
      const own = new Set(found?.clip.kind === "media" ? [found.clip.mediaId] : []);
      // A song's own lyrics aren't the speech it dips under. With ranges, the speech is still read for what plays over it at full level.
      const placed = dipStep(on, step, await speechOn(on, own));
      op = placed.op;
      dips.push(placed.report);
    } else op = step as TimelineOp;
    ops.push(op);
    // A splitJoin step is expanded later, where it falls among the others; it moves no clip in time.
    if (step.op !== "splitJoin") on = applyOps(on, [op]);
  }
  return { ops, dips };
}
