import { planCutReview } from "./cutReview.js";
import { stableStringify } from "./ids.js";
import { replayJoinFades } from "./joinCrossfade.js";
import { applyOps, TimelineOp } from "./ops.js";
import { assignSpots, replayOps, changedSpots, rangesOverlapWithin, planApply, makeTimeMap } from "./rebase.js";
import { WritableTimeline, type Change, type Clip, type Timeline } from "./schema.js";
import { clipEnd } from "./time.js";

interface VersionLink { version: string; parent: string | null; revertsVersion?: string }

/** Walk just this branch. Undoing a revert makes its target effective again. */
export function historyLineage(versions: VersionLink[], head: string | null) {
  const index = new Map(versions.map(v => [v.version, v]));
  const lineage = new Set<string>();
  const undone = new Set<string>();
  let cursor = head && index.get(head);
  while (cursor && !lineage.has(cursor.version)) {
    lineage.add(cursor.version);
    if (cursor.revertsVersion && !undone.has(cursor.version)) undone.add(cursor.revertsVersion);
    cursor = cursor.parent && index.get(cursor.parent);
  }
  return { lineage, undone };
}

const equal = (a: unknown, b: unknown) => stableStringify(a) === stableStringify(b);
/** The tolerance a ripple reads two times as meeting within (MEET in ops.ts): a clip this short has no footage in it. */
const NO_LENGTH = 1e-9;
export class HistoryConflict extends Error {}

function layoutClip(c: Clip) {
  return [c.id, c.kind, c.timelineIn, c.kind === "media" ? [c.mediaId, c.sourceIn, c.sourceOut, c.speed] : c.timelineOut];
}

function layout(t: Timeline) {
  return t.tracks.map(track => [track.id, track.kind, track.clips.map(layoutClip)]);
}

function conflict(field: string): never {
  throw new HistoryConflict(`a later edit also depends on ${field}`);
}

// An edit touching the same property group (for example caption text and word
// timing) must not be partially overwritten. Treat nested values atomically.
function mergeFields<T extends object>(base: T, next: T, onto: T, field: string, exclude: string[] = []): T {
  const result = { ...onto };
  const changed = Object.keys({ ...base, ...next }).filter(k => !exclude.includes(k) && !equal(base[k as keyof T], next[k as keyof T]));
  const groups = [["text", "words"], ["transform", "keyframes"], ["time", "end"]];
  for (const k of changed) {
    const coupled = groups.find(g => g.includes(k)) ?? [k];
    if (coupled.some(key => !equal(base[key as keyof T], onto[key as keyof T]))) conflict(field + "." + k);
    if (k in next) result[k as keyof T] = next[k as keyof T];
    else delete result[k as keyof T];
  }
  return result;
}

function mergeItems<T extends { id: string }>(base: T[], next: T[], onto: T[], merge: (a: T, b: T, c: T) => T): T[] {
  if (equal(base, next)) return onto;
  if (equal(base, onto)) return next;
  const before = new Map(base.map(item => [item.id, item]));
  const after = new Map(next.map(item => [item.id, item]));
  const current = new Map(onto.map(item => [item.id, item]));
  const ids = (items: T[]) => items.map(i => i.id);
  const reordered = !equal(ids(base.filter(i => after.has(i.id))), ids(next.filter(i => before.has(i.id))));
  if (reordered && !equal(ids(base), ids(onto))) conflict("item order");
  for (const a of base) {
    const b = after.get(a.id), c = current.get(a.id);
    if (equal(a, b)) continue;
    if (!c || (!b && !equal(c, a))) conflict(a.id);
    if (b) current.set(a.id, merge(a, b, c));
    else current.delete(a.id);
  }
  for (const b of next) {
    if (before.has(b.id)) continue;
    if (current.has(b.id)) conflict(b.id);
    current.set(b.id, b);
  }
  // Preserve the order on both sides, including positions of newly inserted items.
  const order = reordered ? ids(next) : ids(onto.filter(i => current.has(i.id)));
  if (!reordered) {
    let position = 0;
    for (const item of next) {
      const at = order.indexOf(item.id);
      if (at >= 0) position = at + 1;
      else if (current.has(item.id)) order.splice(position++, 0, item.id);
    }
  }
  return order.map(id => current.get(id)!);
}

function geometryKey(clip: Clip) {
  return clip.kind === "media" ? [clip.kind, clip.mediaId, clip.sourceIn] : [clip.kind, clip.label];
}

// Ripple operations allocate new clip IDs. Restore the IDs of the historical
// right-hand pieces so later edits and notes can still address them.
function preserveSplitIds(result: Timeline, onto: Timeline, base: Timeline, next: Timeline) {
  const known = new Set(onto.tracks.flatMap(t => t.clips.map(c => c.id)));
  const original = new Set(base.tracks.flatMap(t => t.clips.map(c => c.id)));
  const key = (c: Clip) => stableStringify(geometryKey(c));
  for (const track of result.tracks) {
    // A long pass leaves hundreds of pieces per track. Serialize each once, not once per pair.
    const fresh = new Map<string, Clip[]>();
    for (const other of next.tracks.find(t => t.id === track.id)?.clips ?? []) {
      if (original.has(other.id)) continue;
      const k = key(other);
      const same = fresh.get(k);
      if (same) same.push(other);
      else fresh.set(k, [other]);
    }
    for (const c of track.clips) {
      if (known.has(c.id)) continue;
      const matches = fresh.get(key(c)) ?? [];
      if (matches.length !== 1) conflict("split footage");
      c.id = matches[0]!.id;
    }
  }
  return result;
}

/** Move an actual recorded delta onto a cut without the edit being undone. */
export function replayHistoryEdit(base: Timeline, next: Timeline, onto: Timeline, change: Change | null, fps: number, original?: () => Timeline): Timeline {
  const content = (t: Timeline) => ({ ...t, version: "", parent: null, createdAt: undefined });
  if (equal(content(base), content(onto))) return next;
  const moved = !equal(layout(base), layout(onto));
  const laterRipple = change?.ops?.some(o => o.op === "rippleDelete" || o.op === "rippleInsertGap");
  // A ripple must run on the restored footage, even if only its properties
  // changed. Copying its saved split clips would resurrect removed properties.
  let needsReplay = !!laterRipple;
  if (moved && (!equal(base.tracks, next.tracks) || !equal(base.markers, next.markers))) {
    const removed = changedSpots(base, onto, { fps }).map(s => s.before);
    const added = changedSpots(base, next, { fps }).map(s => s.before);
    // Separate additions/removals can be merged by stable ID if the surviving
    // clips retain their exact geometry. A ripple or trim needs source mapping.
    const positions = new Map(onto.tracks.flatMap(t => t.clips.map(c => [c.id, layoutClip(c)] as const)));
    const retimed = base.tracks.some(t => t.clips.some(c => positions.has(c.id) && !equal(layoutClip(c), positions.get(c.id))));
    needsReplay ||= retimed || !!rangesOverlapWithin(removed, added, 0)
      || !equal(base.markers, next.markers);
  }
  if (needsReplay) {
    const ops = TimelineOp.array().safeParse(change?.ops);
    if (!ops.success || !ops.data.length) conflict("the timing of this edit");
    // Only replay operations whose recorded effect we can reproduce exactly.
    const supported = ops.data.every(o => ["rippleDelete", "rippleInsertGap", "updateClip", "addMarker"].includes(o.op));
    if (!supported) conflict("the timing of this edit");
    // A pass applied with some of its calls skipped still holds every cut it staged, and its saved version only the
    // cuts that went in. Those are the ones replayed: the review's cuts without the skipped ones, last first.
    let applied = ops.data;
    const review = change?.restoredCuts?.length ? planCutReview(original?.() ?? base, next, [], change.ops) : null;
    if (review) {
      const skipped = new Set(change!.restoredCuts);
      applied = review.cuts.flatMap((cut, i) => skipped.has(i) ? [] : [{ op: "rippleDelete" as const, ...cut.removed }]).reverse();
      // Every call was skipped: the pass changed nothing.
      if (!applied.length) return onto;
    }
    let recorded = applied;
    if (original && change && (change.fromVersion !== base.version || change.approvedSpots)) {
      const proposedOn = original();
      const owners = change.approvedSpots && (change.spotAssignment?.fps === fps ? change.spotAssignment.owners :
        assignSpots(proposedOn, ops.data, change.ranges, undefined, fps));
      if (change.approvedSpots && !owners) conflict("the approved spots");
      const selected = new Set(change.approvedSpots);
      recorded = [];
      replayOps(proposedOn, applied, base, i => !owners || owners[i] === null || selected.has(owners[i]!), fps, recorded);
    }
    // Scarlet's crossfade on the joins goes back as it was made: the ops hold only the removals.
    const recordedFades = change?.appliedVersion && change.appliedJoinFades ? change.appliedJoinFades : change?.joinFades;
    const fades = recordedFades?.fades.length ? recordedFades : undefined;
    const cut = applyOps(base, recorded);
    const trial = preserveSplitIds(fades ? replayJoinFades(cut, fades.fades, fades.duration) : cut, base, base, next);
    // A ripple saved before a clip's edge and a cut's were read as meeting could leave a clip of no length after the cut,
    // under a new id. Nothing plays in one, so a saved version that holds one is still the edit recorded. One left
    // before the cut kept the clip's own id and gave the footage a new one: that version is still refused.
    const played = (t: Timeline) => ({ ...content(t), tracks: t.tracks.map(track => ({ ...track, clips: track.clips.filter(c => clipEnd(c) - c.timelineIn > NO_LENGTH) })) });
    if (!equal(played(trial), played(next))) conflict("the recorded edit");
    if (recorded.some(o => o.op === "addMarker")) {
      const map = makeTimeMap(base, onto, fps);
      for (const op of recorded) if (op.op === "addMarker" && (map(op.marker.time) === null || (op.marker.end !== undefined && map(op.marker.end) === null))) conflict("the marker’s footage");
    }
    const plan = planApply({ from: base, to: next, head: onto, ops: recorded, changeRanges: change!.ranges, fps });
    if (plan.kind === "conflict") throw new HistoryConflict(plan.reason);
    let replayed = plan.timeline;
    if (fades && plan.kind !== "fast-forward") {
      // The removals landed on another cut: each fade goes on the same join there.
      const map = makeTimeMap(cut, replayed, fps);
      const moved = fades.fades.flatMap(f => { const at = map(f.at, "right"); return at === null ? [] : [{ ...f, at }]; });
      replayed = replayJoinFades(replayed, moved, fades.duration);
    }
    return WritableTimeline.parse(preserveSplitIds(replayed, onto, base, next));
  }
  const merged = mergeFields(base, next, onto, "timeline", ["tracks", "markers", "version", "parent", "createdAt"]);
  merged.markers = [...mergeItems(base.markers, next.markers, onto.markers, (a, b, c) => mergeFields(a, b, c, a.id))].sort((a,b) => a.time - b.time);
  merged.tracks = mergeItems(base.tracks, next.tracks, onto.tracks, (a, b, c) => ({
    ...mergeFields(a, b, c, a.id, ["clips"]),
    clips: mergeItems(a.clips, b.clips, c.clips, (x, y, z) => mergeFields(x, y, z, x.id)),
  }));
  return WritableTimeline.parse(merged);
}

interface HistoryEntry extends VersionLink { description?: string; changeId: string | null }

export function planRevert(versions: HistoryEntry[], head: string, target: string, fps: number,
  timeline: (id: string) => Timeline, change: (id: string) => Change | null) {
  const { lineage, undone } = historyLineage(versions, head);
  const index = new Map(versions.map(v => [v.version, v]));
  const selected = index.get(target);
  if (!selected?.parent || !lineage.has(target)) throw new HistoryConflict("This version is outside the current branch’s edit history.");
  if (undone.has(target)) throw new HistoryConflict("This edit has already been undone on this branch.");
  if (head === target) return timeline(selected.parent);
  // Evaluate recorded reverts as operations on history. Replaying a revert as
  // an ordinary replacement would reintroduce an earlier edit on a second undo.
  const hypothetical = { version: "pending-revert", parent: head, revertsVersion: target };
  const effective = historyLineage([...versions, hypothetical], hypothetical.version);
  let result: Timeline | undefined;
  for (const id of [...lineage].reverse()) {
    const entry = index.get(id)!;
    if (!entry.parent) continue;
    if (entry.revertsVersion || effective.undone.has(id)) {
      result ??= timeline(entry.parent);
      continue;
    }
    if (!result) continue;
    try {
      const edit = entry.changeId ? change(entry.changeId) : null;
      result = replayHistoryEdit(timeline(entry.parent), timeline(id), result, edit, fps, edit ? () => timeline(edit.fromVersion) : undefined);
    } catch (e) {
      throw new HistoryConflict(`Couldn’t keep “${entry.description ?? entry.version}” while undoing this edit: ${(e as Error).message}. The edit is unchanged.`);
    }
  }
  return result ?? timeline(head);
}
