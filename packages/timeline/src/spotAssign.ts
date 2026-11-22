/** Spot attribution, selective approval, property-edit merging, and apply planning. */
import { ZodError } from "zod/v3";
import { CaptionWord, duplicateClipId } from "./schema.js";
import type { Clip, Timeline, TimeRange } from "./schema.js";
import { OpError, applyOp, applyOpInPlace, replayOnCopy, type TimelineOp } from "./ops.js";
import { clipEnd, findClip, isGlobalRippleDelete, sourceAt, timelineDuration } from "./time.js";
import { intervalCandidates } from "./intervals.js";
import { stableStringify } from "./ids.js";
import { makeTimeMap, REBASE_EPS, roundedTime, sameContent, type TimeMap } from "./timeMap.js";
import { changedSpots, rangesOverlapWithin, type ChangedSpot } from "./changedSpots.js";
import { RebaseConflict, replayOps } from "./replayOps.js";

function sameRanges(actual: TimeRange[], expected: TimeRange[]): boolean {
  return actual.length === expected.length && actual.every((r, i) =>
    Math.abs(r.start - expected[i]!.start) < 1e-4 && Math.abs(r.end - expected[i]!.end) < 1e-4);
}

/** Check the replay from both directions. It must change only selected footage
 * on the original cut and differ from the full proposal only at skipped spots. */
function replaySelection(base: Timeline, to: Timeline, ops: TimelineOp[], owners: Array<number | null>, spots: ChangedSpot[], keep: Set<number>, fps: number): Timeline | null {
  let timeline: Timeline;
  try {
    const selected = (i: number) => owners[i] === null || keep.has(owners[i]!);
    timeline = (ops.every(isPropertyEdit) || descendingCuts(ops)) ? replayOnCopy(base, ops.filter((_, i) => selected(i))) :
      replayOps(base, ops, base, selected, fps);
  } catch (error) {
    if (error instanceof RebaseConflict || error instanceof OpError || error instanceof ZodError) return null;
    throw error;
  }
  const applied = changedSpots(base, timeline, { fps }).map((s) => s.before);
  const skipped = changedSpots(timeline, to, { fps }).map((s) => s.after);
  return sameRanges(applied, spots.filter((_, i) => keep.has(i)).map((s) => s.before)) &&
    sameRanges(skipped, spots.filter((_, i) => !keep.has(i)).map((s) => s.after)) ? timeline : null;
}

type RippleDelete = Extract<TimelineOp, { op: "rippleDelete" }>;

// A cut at a later time cannot move an earlier, disjoint cut's coordinates.
function descendingCuts(ops: TimelineOp[]): ops is RippleDelete[] {
  let limit = Infinity;
  for (const op of ops) {
    if (!isGlobalRippleDelete(op) || op.end > limit || op.start >= op.end) return false;
    limit = op.start;
  }
  return true;
}

/** Recognize independent removals on continuous chronological recordings. The saved diff
 * must identify each exact deleted interval and its corresponding join. Other layouts
 * (gapped overlays, repeated footage, fades) still go through the general replay verifier. */
export function independentCutSpots(base: Timeline, ops: TimelineOp[], differences: ChangedSpot[], fps: number) {
  if (ops.length < 2 || ops.length !== differences.length || !descendingCuts(ops)) return;
  const populated = base.tracks.filter(track => track.clips.length);
  if (!populated.some(track => track.kind === "video" && !track.hidden)) return;
  const sources = new Set<string>();
  const duration = timelineDuration(base);
  for (const track of populated) {
    const first = track.clips[0]!;
    if (track.kind === "caption" || first.kind !== "media" || sources.has(first.mediaId)) return;
    sources.add(first.mediaId);
    let end = 0, previousSourceOut = 0;
    for (const clip of track.clips) {
      if (clip.kind !== "media" || clip.mediaId !== first.mediaId || clip.sourceOut <= clip.sourceIn || clip.sourceIn < previousSourceOut ||
          Math.abs(clip.timelineIn - end) > REBASE_EPS || !clip.enabled || clip.speed !== 1 ||
          clip.effects.length || clip.keyframes?.length || clip.audioFadeIn || clip.audioFadeOut ||
          clip.videoFadeIn || clip.videoFadeOut || clip.transitionIn) return;
      end = clipEnd(clip);
      previousSourceOut = clip.sourceOut;
    }
    if (Math.abs(end - duration) > REBASE_EPS) return;
  }
  const owners: number[] = [];
  let shift = 0;
  for (let i = 0; i < differences.length; i++) {
    const opIndex = ops.length - 1 - i;
    const op = ops[opIndex]!;
    const { before, after } = differences[i]!;
    const join = op.start - shift;
    if (op.end - op.start < 1 / fps + REBASE_EPS || op.end > duration || Math.abs(before.start - op.start) > REBASE_EPS || Math.abs(before.end - op.end) > REBASE_EPS ||
        Math.abs(after.start - join) > REBASE_EPS || Math.abs(after.end - join) > REBASE_EPS ||
        (i > 0 && join - differences[i - 1]!.after.end <= 0.3)) return;
    shift += op.end - op.start;
    owners[opIndex] = i;
  }
  return owners;
}

// These properties can only change the existing clip interval. Each must own one
// distinct, complete interval in the actual before/after diff, in both coordinates.
export function independentClipSpots(base: Timeline, ops: TimelineOp[], spots: TimeRange[], tolerance: number, fps: number, knownDiff?: ChangedSpot[]) {
  if (ops.length !== spots.length || ops.length < 2 || !ops.every(op => op.op === "updateClip")) return;
  const clips = new Map<string, Clip>();
  for (const track of base.tracks) {
    let start = -Infinity;
    for (const clip of track.clips) {
      // Applying a property edit also sorts its track. Use the full replay for unordered legacy tracks.
      if (clip.timelineIn < start || clips.has(clip.id)) return;
      start = clip.timelineIn;
      clips.set(clip.id, clip);
    }
  }
  const owners: number[] = [];
  for (const op of ops) {
    const clip = clips.get(op.clipId);
    if (!clip || !Object.keys(op.patch).every(key => clip.kind === "media" ? key === "volume" || key === "opacity"
      : clip.kind === "caption" && (key === "text" || key === "style"))) return;
    const end = clipEnd(clip);
    const matches = spots.flatMap((spot, i) => clip.timelineIn >= spot.start - tolerance && end <= spot.end + tolerance ? [i] : []);
    const i = matches[0];
    if (matches.length !== 1 || i === undefined || Math.abs(spots[i]!.start - clip.timelineIn) > 1e-9 ||
        Math.abs(spots[i]!.end - end) > 1e-9) return;
    owners.push(i);
  }
  if (new Set(owners).size !== spots.length) return;
  const differences = knownDiff ?? changedSpots(base, replayOnCopy(base, ops), { fps });
  if (sameRanges(differences.map(s => s.after), spots) && sameRanges(differences.map(s => s.before), spots)) return owners;
}

/**
 * Map each operation to one independently selectable spot. A null entry is an
 * operation with no visible footprint. A null result means the spots must be
 * approved together (one edit spans spots, or a footprint cannot be attributed).
 */
export function assignSpots(base: Timeline, ops: TimelineOp[], spots: TimeRange[], fps = 30): Array<number | null> | null {
  const tolerance = 0.3;
  const independent = independentClipSpots(base, ops, spots, tolerance, fps);
  if (independent) return independent;
  const states: Timeline[] = [base];
  for (const op of ops) states.push(applyOp(states[states.length - 1]!, op));
  const final = states[states.length - 1]!;
  const owners: Array<number | null> = [];
  for (let i = 0; i < ops.length; i++) {
    const next = states[i + 1]!;
    const toFinal = makeTimeMap(next, final, fps);
    let owner: number | null = null;
    for (const { after } of changedSpots(states[i]!, next, { gap: 0, fps })) {
      const a = toFinal(after.start, "right");
      const b = toFinal(after.end, "left");
      if (a === null || b === null) return null;
      const matches = spots.flatMap((s, k) =>
        Math.min(a, b) >= s.start - tolerance && Math.max(a, b) <= s.end + tolerance ? [k] : []);
      if (matches.length !== 1 || (owner !== null && owner !== matches[0])) return null;
      owner = matches[0]!;
    }
    owners.push(owner);
  }
  const covered = new Set(owners);
  if (!spots.every((_, i) => covered.has(i))) return null;
  const differences = changedSpots(base, final, { fps });
  if (!sameRanges(differences.map((s) => s.after), spots)) return null;
  // A preceding edit can mask the footprint of a later edit (e.g. removing
  // one caption before hiding its track). Exercise every spot in isolation.
  return spots.every((_, i) => replaySelection(base, final, ops, owners, differences, new Set([i]), fps)) ? owners : null;
}

export function canApproveSpots(base: Timeline, ops: TimelineOp[] | undefined, ranges: TimeRange[], fps = 30): boolean {
  return ranges.length > 1 && !!ops?.length && assignSpots(base, ops, ranges, fps) !== null;
}

export type ApplyPlan =
  | { kind: "fast-forward"; timeline: Timeline }
  | { kind: "rebased" | "partial"; timeline: Timeline }
  | { kind: "conflict"; reason: string; at?: number; spotsUnsupported?: boolean };

// Properties within a group can depend on one another (e.g. a new caption
// text and its word timings). Timing, source and unknown fields stay structural.
const propertyGroups = new Map<string, string>([
  ["text", "caption"], ["words", "caption"], ["style", "style"],
  ["transform", "transform"], ["keyframes", "transform"], ["color", "color"],
  ["volume", "volume"], ["audioFadeIn", "audioFadeIn"], ["audioFadeOut", "audioFadeOut"],
  ["opacity", "opacity"], ["videoFadeIn", "videoFadeIn"], ["videoFadeOut", "videoFadeOut"], ["transitionIn", "transitionIn"],
]);

/** Compare layers in the target's local time, including the source samples
 * underneath it. Trimming earlier footage can translate the entire window. */
function propertyEditLayers(tl: Timeline, batch: boolean) {
  // Historical versions can have duplicate IDs. Their context includes every clip bearing the target ID.
  const indexed = batch && duplicateClipId(tl.tracks) === undefined;
  return tl.tracks.map(({ clips, name: _name, ...track }) => ({
    track, clipsIn: indexed ? intervalCandidates(clips, c => c.timelineIn, clipEnd) : () => clips,
  }));
}

function clipEditContext(tl: Timeline, layers: ReturnType<typeof propertyEditLayers>, target: Clip, groups: Set<string>): string {
  const start = target.timelineIn;
  const end = clipEnd(target);
  const contextLayers = layers.flatMap(({ track, clipsIn }) => {
    const context = clipsIn(start, end).flatMap((clip) => {
      const left = Math.max(start, clip.timelineIn);
      const right = Math.min(end, clipEnd(clip));
      if (right <= left && clip.id !== target.id) return [];
      const properties: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(clip)) {
        if (["id", "label", "timelineIn", "timelineOut", "sourceIn", "sourceOut"].includes(key)) continue;
        const group = propertyGroups.get(key);
        if (group && (clip.id !== target.id || !groups.has(group))) continue;
        properties[key] = key === "words" && clip.kind === "caption"
          ? clip.words?.map((w) => [w.text, roundedTime(w.start - start), roundedTime(w.end - start)])
          : value;
      }
      const source = clip.kind === "media" ? [roundedTime(sourceAt(clip, left)), roundedTime(sourceAt(clip, right))] : null;
      return [{ target: clip.id === target.id, left: roundedTime(left - start), right: roundedTime(right - start), source, properties }];
    });
    return context.length ? [{ track, context }] : [];
  });
  return stableStringify([tl.background, tl.captionStyle, contextLayers]);
}

type ClipUpdate = Extract<TimelineOp, { op: "updateClip" }>;

function isPropertyEdit(op: TimelineOp): op is ClipUpdate {
  return op.op === "updateClip" && Object.keys(op.patch).every((key) => propertyGroups.has(key));
}

function mergePropertyEdits(base: Timeline, head: Timeline, edits: ClipUpdate[], fps: number): Timeline {
  if (!edits.length) return head;
  const merged = structuredClone(head);
  const baseLayers = propertyEditLayers(base, edits.length > 1);
  const headLayers = propertyEditLayers(head, edits.length > 1);
  let map: TimeMap | undefined;
  for (const [i, edit] of edits.entries()) {
    const before = findClip(base, edit.clipId);
    const current = findClip(head, edit.clipId);
    const groups = new Set(Object.keys(edit.patch).map((key) => propertyGroups.get(key)!));
    if (!before || !current || clipEditContext(base, baseLayers, before, groups) !== clipEditContext(head, headLayers, current, groups)) {
      throw new RebaseConflict(`the properties or footage for clip ${edit.clipId} changed since`, i, before?.timelineIn);
    }
    const shift = current.timelineIn - before.timelineIn;
    if (shift !== 0) {
      map ??= makeTimeMap(base, head, fps);
      const mapped = map(before.timelineIn, "right");
      if (mapped === null || Math.abs(mapped - current.timelineIn) > REBASE_EPS) {
        throw new RebaseConflict(`clip ${edit.clipId} moved to different footage`, i, before.timelineIn);
      }
    }
    const patch = { ...edit.patch };
    if (shift !== 0 && current.kind === "caption" && Array.isArray(patch.words)) {
      patch.words = CaptionWord.array().parse(patch.words).map((w) => ({ ...w, start: w.start + shift, end: w.end + shift }));
    }
    try {
      applyOpInPlace(merged, { ...edit, patch });
    } catch (error) {
      throw new RebaseConflict(`edit ${i + 1} no longer applies: ${(error as Error).message}`, i);
    }
  }
  return merged;
}

/**
 * Work out how to put an approved change into the current cut.
 *
 * - Cut unchanged and every spot approved: take the change as-is.
 * - Cut moved on: re-apply the change's edits onto it, unless they touch the
 *   same clip properties or depend on footage that changed. Structural edits
 *   use the conservative time-overlap check.
 * - Some spots approved: apply only the edits for those spots.
 */
export function planApply(input: { from: Timeline; to: Timeline; head: Timeline; ops?: TimelineOp[]; spots?: number[]; changeRanges: TimeRange[]; fps?: number },
  verifiedOwners?: Array<number | null> | null): ApplyPlan {
  const { from, to, head, ops, changeRanges, fps = 30 } = input;
  const all = !input.spots || changeRanges.every((_, i) => input.spots!.includes(i));
  const sameBase = head.name === from.name && sameContent(head, from);
  if (sameBase && all) return { kind: "fast-forward", timeline: to };
  if (!ops || !ops.length) {
    return {
      kind: "conflict",
      spotsUnsupported: !all,
      reason: !all
        ? "this edit replaces the whole timeline, so its spots can't be approved individually"
        : "this edit replaces the whole timeline, which now has a newer version",
    };
  }
  const keep = new Set(input.spots);
  const owners = all ? null : verifiedOwners !== undefined ? verifiedOwners : assignSpots(from, ops, changeRanges, fps);
  const propertyEdits = ops.every(isPropertyEdit) ? ops : undefined;
  // A full property approval only needs to inspect the clips it depends on.
  const differences = all && propertyEdits ? [] : changedSpots(from, to, { fps });
  const selection = owners && replaySelection(from, to, ops, owners, differences, keep, fps);
  if (!all && !selection) {
    return { kind: "conflict", spotsUnsupported: true, reason: "the edits for these spots cannot be applied independently" };
  }
  if (head === from && selection) return { kind: "partial", timeline: selection };
  const mine = differences.filter((_, i) => all || keep.has(i)).map((s) => s.before);
  const include = (i: number) => all || owners![i] === null || keep.has(owners![i]!);
  try {
    let timeline: Timeline;
    if (propertyEdits) {
      timeline = mergePropertyEdits(from, head, propertyEdits.filter((_, i) => include(i)), fps);
    } else {
      const since = changedSpots(from, head, { fps }).map((s) => s.before);
      const hit = rangesOverlapWithin(mine, since);
      if (hit) return { kind: "conflict", reason: `it overlaps with a change approved since (around ${hit.start.toFixed(1)} s)`, at: hit.start };
      timeline = replayOps(from, ops, head, include, fps);
    }
    if (!all) {
      const map = makeTimeMap(from, head, fps);
      const mapped = mine.map((r) => ({ start: map(r.start, "right"), end: map(r.end, "left") }));
      const expected = mapped.filter((r): r is TimeRange => r.start !== null && r.end !== null);
      if (expected.length !== mine.length || !sameRanges(changedSpots(head, timeline, { fps }).map((s) => s.before), expected)) {
        return { kind: "conflict", reason: "the selected edits would affect different footage in the current edit" };
      }
    }
    return { kind: all ? "rebased" : "partial", timeline };
  } catch (e) {
    if (e instanceof RebaseConflict) return { kind: "conflict", reason: e.message, at: e.at };
    throw e;
  }
}
