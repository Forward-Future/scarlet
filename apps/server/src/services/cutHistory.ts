import type { User } from "@scarlet/shared";
import { adjustCut, adjustEdit, clipEnd, diffTimelines, frameAligned, HistoryConflict, makeTimeMap, newId, planRevert, putBackCut, putBackLooks, putBackMarkers, putBackSplit, timelineDuration, type Change, type TimeRange, type Timeline } from "@scarlet/timeline";
import type { Ctx } from "../context.js";
import { now } from "../db.js";
import { conflict, notFound } from "../errors.js";
import { actorFor, logActivity, quote } from "./activity.js";
import { ensureProjectHead, resolveTimeline, storeVersion } from "./timeline.js";

export function checkoutVersion(ctx: Ctx, user: User, projectId: string, target: string) {
  return ctx.db.transaction(() => {
    const project = ensureProjectHead(ctx, projectId);
    const { head } = project;
    if (!ctx.repos.versions.exists(project.id, target)) throw notFound(`version ${target}`);
    if (target === head) throw conflict("already_head", "that version is already the head");
    const change: Change = {
      id: newId("chg"),
      projectId: project.id,
      fromVersion: head,
      toVersion: target,
      description: `Checked out version ${target}`,
      author: actorFor(user),
      noteIds: [],
      ranges: [],
      state: "approved",
      renders: [],
      createdAt: now(),
      updatedAt: now(),
    };
    ctx.repos.changes.put(change);
    const updated = ctx.repos.projects.update(project.id, { head: target });
    ctx.bus.publish({ type: "change.updated", projectId: project.id, change });
    ctx.bus.publish({ type: "project.updated", projectId: project.id, project: updated });
    const previous = ctx.repos.versions.get(project.id, head);
    const restored = ctx.repos.versions.get(project.id, target);
    logActivity(ctx, {
      projectId: project.id,
      actor: actorFor(user),
      type: "version.restored",
      summary: `${user.name} restored an earlier version of the edit${restored?.description ? `: ${quote(restored.description)}` : ""}`,
      data: {
        changeId: change.id,
        branch: project.branch,
        version: target,
        from: head,
        ...(previous && { durationBefore: timelineDuration(previous.timeline) }),
        ...(restored && { durationAfter: timelineDuration(restored.timeline) }),
      },
    });
    return { project: updated };
  }, "immediate")();
}

export function recordHistoryEdit(ctx: Ctx, user: User, projectId: string, target: string,
  action: "revert" | "restore", expectedHead: string, branch: string) {
  return ctx.db.transaction(() => {
    const project = ensureProjectHead(ctx, projectId);
    const { head } = project, timeline = resolveTimeline(ctx, project);
    if (head !== expectedHead || project.branch !== branch) throw conflict("cut_changed", "The video changed. Try again.");
    const selected = ctx.repos.versions.get(projectId, target);
    if (!selected) throw notFound("version");
    let result = selected.timeline;
    if (action === "revert") {
      try {
        result = planRevert(ctx.repos.versions.links(projectId), head, target, project.settings.fps,
          id => resolveTimeline(ctx, project, id), id => ctx.repos.changes.get(id));
      } catch (e) {
        if (e instanceof HistoryConflict) throw conflict("revert_conflict", e.message);
        throw e;
      }
    } else if (head === target) throw conflict("already_head", "The video is already on this version.");
    const description = `${action === "revert" ? "Undo" : "Restore"} · ${selected.description ?? target}`;
    const author = actorFor(user);
    const id = newId("chg");
    const saved = storeVersion(ctx, projectId, result, { parent: head, author, description, changeId: id });
    const change: Change = { id, projectId, description, author, decidedBy: author, state: "approved",
      fromVersion: head, toVersion: saved.version, appliedOnto: head, appliedVersion: saved.version,
      revertsVersion: action === "revert" ? target : undefined, noteIds: [], renders: [],
      ranges: diffTimelines(timeline, saved, project.settings.fps).ranges, createdAt: now(), updatedAt: now() };
    ctx.repos.changes.put(change);
    const updated = ctx.repos.projects.update(projectId, { head: saved.version });
    ctx.bus.publish({ type: "change.updated", projectId, change });
    ctx.bus.publish({ type: "project.updated", projectId, project: updated });
    logActivity(ctx, { projectId, actor: author, type: action === "revert" ? "change.undone" : "version.restored",
      summary: description, data: {
        changeId: id, target, from: head, version: saved.version, branch,
        durationBefore: timelineDuration(timeline), durationAfter: timelineDuration(saved), rangesCount: change.ranges.length,
      } });
    return { project: updated, change };
  }, "immediate")();
}

/**
 * An edit the editor rejected, as their list has it on the video now. A cut says where its join is and the footage it
 * took out; any other edit says the stretch it plays in. `revised` is an edit that has had a revision: only what its
 * latest version changed is known here.
 */
export interface RejectedEdit {
  changeId: string; spot: number; label: string; range: TimeRange; revised?: boolean;
  /** All the edit did was leave a marker for the editor, such as a to-do: rejecting it takes that marker off. */
  marker?: boolean;
  at?: number; before?: { version: string; removed: TimeRange };
}

/**
 * Reject applied edits with no model, wherever the engine knows exactly what they changed. A cut's footage goes back at
 * its join. An edit of a change that only set how clips look or sound goes back to how those clips were. A split edit's
 * sound cuts with its picture again. A to-do's marker comes off. A change whose
 * every edit is rejected comes out whole, as History's Undo takes it out. Every other edit stays as it is.
 *
 * It is refused (`needs_scarlet`) where the engine can't tell what an edit changed, where a later edit changed it
 * since, or where the result doesn't play a cut's footage whole: the editor's × asks Scarlet then.
 */
export function rejectEdits(ctx: Ctx, user: User, projectId: string, threadId: string, rejected: RejectedEdit[], expectedHead: string, branch: string) {
  return ctx.db.transaction(() => {
    const project = ensureProjectHead(ctx, projectId);
    const { head } = project, timeline = resolveTimeline(ctx, project);
    if (head !== expectedHead || project.branch !== branch) throw conflict("cut_changed", "The video changed. Try again.");
    const fps = project.settings.fps;
    const unclear = () => conflict("needs_scarlet", "This edit can’t be put back as it was.");
    const cuts = rejected.filter((e): e is RejectedEdit & { at: number; before: NonNullable<RejectedEdit["before"]> } => e.at !== undefined && !!e.before);
    const others = rejected.filter(e => e.at === undefined || !e.before);
    let result = timeline;
    const byChange = new Map<string, RejectedEdit[]>();
    for (const edit of others) byChange.set(edit.changeId, [...byChange.get(edit.changeId) ?? [], edit]);
    for (const [changeId, edits] of byChange) {
      const change = ctx.repos.changes.get(changeId);
      const version = change?.appliedVersion ?? change?.toVersion;
      if (!change || change.projectId !== projectId || change.state !== "approved" || !version || edits.some(e => e.revised)) throw unclear();
      const named = change.timelineEdits;
      const spots = new Set(edits.map(e => e.spot));
      // The footage a built video left out is the change's too, a cut of its own on each row after the named edits:
      // while those stand, the named edits aren't every edit, and taking the change out would put their footage back.
      const everyEdit = named?.length && named.length === spots.size && [...spots].every(spot => spot < named.length) && !change.leftOut?.joins.length;
      if (everyEdit && rejected.length === edits.length) {
        // Every edit the change made is rejected and nothing else is: the change comes out, with what was made on it kept.
        try {
          result = planRevert(ctx.repos.versions.links(projectId), head, version, fps, id => resolveTimeline(ctx, project, id), id => ctx.repos.changes.get(id));
        } catch (e) {
          if (e instanceof HistoryConflict) throw unclear();
          throw e;
        }
        continue;
      }
      const before = ctx.repos.versions.get(projectId, change.appliedOnto ?? change.fromVersion)?.timeline;
      const after = ctx.repos.versions.get(projectId, version)?.timeline;
      if (!before || !after || !change.ops?.length) throw unclear();
      for (const edit of edits) {
        const range = named?.[edit.spot]?.range;
        const next = range && (edit.marker ? putBackMarkers(result, before, after, range, fps)
          : putBackLooks(result, before, after, change.ops, range, named!.map(item => item.range), fps)
            ?? putBackSplit(result, before, after, change.ops, range));
        if (!next) throw unclear();
        result = next;
      }
    }
    // Last first, so the joins before each one are still where the editor saw them.
    const placed = [...cuts].sort((a, b) => b.at - a.at);
    for (const cut of placed) {
      const next = putBackCut(result, cut.at, cut.before.removed.end - cut.before.removed.start, fps);
      if (!next) throw unclear();
      result = next;
    }
    // Each stretch of footage must play again, whole and in one piece, where its cut was.
    const edits: NonNullable<Change["timelineEdits"]> = [];
    let moved = 0;
    for (const cut of [...placed].reverse()) {
      const before = ctx.repos.versions.get(projectId, cut.before.version)?.timeline;
      if (!before) throw unclear();
      const { removed } = cut.before, length = removed.end - removed.start;
      const map = makeTimeMap(before, result, fps);
      const start = map(removed.start, "right"), end = map(removed.end, "left");
      if (start === null || end === null || Math.abs(start - (cut.at + moved)) > 1 / fps || Math.abs(end - start - length) > 1 / fps) throw unclear();
      edits.push({ label: cut.label.slice(0, 180), range: { start, end }, replaces: { changeId: cut.changeId, spot: cut.spot } });
      moved += length;
    }
    if (cuts.length && Math.abs(timelineDuration(result) - timelineDuration(timeline) - moved) > 1 / fps) throw unclear();
    // Any other edit is listed where it played, on the video as it runs with the cuts' footage back.
    const toResult = cuts.length ? makeTimeMap(timeline, result, fps) : undefined;
    const end = timelineDuration(result);
    for (const edit of others) {
      const start = toResult ? toResult(edit.range.start, "right") ?? toResult(edit.range.start, "left") : edit.range.start;
      const stop = toResult ? toResult(edit.range.end, "left") ?? toResult(edit.range.end, "right") : edit.range.end;
      const from = Math.min(end, Math.max(0, start ?? edit.range.start));
      edits.push({ label: edit.label.slice(0, 180), range: { start: from, end: Math.min(end, Math.max(from, stop ?? edit.range.end)) },
        replaces: { changeId: edit.changeId, spot: edit.spot } });
    }
    const description = rejected.length > 1 ? `Rejected ${rejected.length} edits` : `Rejected · ${rejected[0]!.label}`;
    const author = actorFor(user);
    const id = newId("chg");
    const saved = storeVersion(ctx, projectId, result, { parent: head, author, description, changeId: id });
    const change: Change = { id, projectId, description, author, decidedBy: author, state: "approved", threadId, rejects: true,
      fromVersion: head, toVersion: saved.version, appliedOnto: head, appliedVersion: saved.version, timelineEdits: edits,
      noteIds: [], renders: [], ranges: diffTimelines(timeline, saved, fps).ranges, createdAt: now(), updatedAt: now() };
    ctx.repos.changes.put(change);
    const updated = ctx.repos.projects.update(projectId, { head: saved.version });
    ctx.bus.publish({ type: "change.updated", projectId, change });
    ctx.bus.publish({ type: "project.updated", projectId, project: updated });
    logActivity(ctx, { projectId, actor: author, type: "change.undone",
      summary: description, data: {
        changeId: id, threadId,
        rejected: rejected.map(c => ({ changeId: c.changeId, spot: c.spot, label: c.label, range: c.range })),
        from: head, version: saved.version, branch,
        durationBefore: timelineDuration(timeline), durationAfter: timelineDuration(saved),
      } });
    return { project: updated, change };
  }, "immediate")();
}

/** Align only the edge(s) that actually moved so an unmoved non-frame-aligned boundary (e.g. a recording end) never drifts. */
function alignMovedEdges(oldRange: TimeRange, nextRange: TimeRange, fps: number): TimeRange {
  const half = 0.5 / fps;
  if (nextRange.end - nextRange.start <= half) return { start: nextRange.start, end: nextRange.start };
  const startMoved = Math.abs(nextRange.start - oldRange.start) >= half;
  const endMoved = Math.abs(nextRange.end - oldRange.end) >= half;
  const aligned = frameAligned(nextRange, fps);
  const start = startMoved ? aligned.start : oldRange.start;
  const end = endMoved ? aligned.end : oldRange.end;
  return end > start ? { start, end } : { start, end: start };
}

/**
 * Exact video-track join edges near `approx`. When adjacent clips have a sub-millisecond overlap or gap before
 * `adjustCut` snaps them together, probing `min(leftEnd, rightStart)` for `"left"` and `max(leftEnd, rightStart)` for
 * `"right"` guarantees each `makeTimeMap` probe lands on its own side of the join.
 */
function findVideoJoinEdges(tl: Timeline, approx: number, fps: number): { at: number; leftAt: number; rightAt: number } {
  const tol = 1.5 / fps;
  let leftEnd: number | undefined, leftDist = Infinity;
  let rightStart: number | undefined, rightDist = Infinity;
  for (const track of tl.tracks) {
    if (track.kind !== "video") continue;
    for (const clip of track.clips) {
      const end = clipEnd(clip);
      const de = Math.abs(end - approx);
      if (de <= tol && de < leftDist) { leftEnd = end; leftDist = de; }
      const ds = Math.abs(clip.timelineIn - approx);
      if (ds <= tol && ds < rightDist) { rightStart = clip.timelineIn; rightDist = ds; }
    }
  }
  const L = leftEnd ?? rightStart ?? approx;
  const R = rightStart ?? leftEnd ?? approx;
  return { at: leftEnd ?? rightStart ?? approx, leftAt: Math.min(L, R), rightAt: Math.max(L, R) };
}

/** An applied cut whose edges the editor dragged directly on the timeline. */
export interface AdjustedCutTarget {
  changeId: string;
  spot: number;
  label: string;
  range: TimeRange;
  at: number;
  before: { version: string; removed: TimeRange };
}

/**
 * Adjust an applied cut's edges directly with no model, moving only the clips meeting at its join and shifting
 * everything after it. If both edges are pulled together to zero, delegates to `rejectEdits` to put the cut back whole.
 * Refuses (`needs_scarlet`) when another edit spans the join or the footage no longer matches cleanly.
 */
export function adjustAppliedCut(ctx: Ctx, user: User, projectId: string, threadId: string, cut: AdjustedCutTarget,
  nextRemoved: TimeRange, expectedHead: string, branch: string) {
  return ctx.db.transaction(() => {
    const project = ensureProjectHead(ctx, projectId);
    const { head } = project, timeline = resolveTimeline(ctx, project);
    if (head !== expectedHead || project.branch !== branch) throw conflict("cut_changed", "The video changed. Try again.");
    const rate = project.settings.fps;
    const unclear = () => conflict("needs_scarlet", "This cut can’t be adjusted directly. Use Revise instead.");
    const before = ctx.repos.versions.get(projectId, cut.before.version)?.timeline;
    if (!before) throw unclear();
    const oldRemoved = cut.before.removed;
    const oldLength = oldRemoved.end - oldRemoved.start;
    if (oldLength <= 0.5 / rate) throw unclear();
    const target = alignMovedEdges(oldRemoved, nextRemoved, rate);
    const pullsToZero = target.end - target.start <= 0.5 / rate;
    const deltaStart = target.start - oldRemoved.start;
    const deltaEnd = target.end - oldRemoved.end;
    if (!pullsToZero && Math.abs(deltaStart) < 0.5 / rate && Math.abs(deltaEnd) < 0.5 / rate) throw conflict("unchanged", "Cut edges did not move.");
    const media = ctx.repos.projects.get(projectId)?.media;
    const dur = timelineDuration(timeline);
    const isOpening = cut.at <= 0.5 / rate;
    // A rearranged interior cut that mapped to 0:00 is not an opening cut: its `before` footage doesn't start at 0:00.
    if (isOpening && oldRemoved.start > 1 / rate) throw unclear();
    const isClosing = !isOpening && dur > 0.5 / rate && !timeline.tracks.some(t => t.clips.some(c => c.timelineIn >= cut.at - 0.5 / rate))
      && Math.abs(oldRemoved.end - timelineDuration(before)) <= 1.5 / rate;
    const fullDelta = isOpening
      ? { ds: 0, de: -oldLength }
      : isClosing
        ? { ds: oldLength, de: 0 }
        : { ds: deltaStart, de: deltaEnd };
    const result = pullsToZero
      ? (putBackCut(timeline, cut.at, oldLength, rate) ?? adjustCut(timeline, cut.at, oldLength, fullDelta.ds, fullDelta.de, rate, media))
      : adjustCut(timeline, cut.at, oldLength, deltaStart, deltaEnd, rate, media);
    if (!result) throw unclear();
    const approxJoin = Math.max(0, cut.at + deltaStart);
    const newJoin = pullsToZero || isOpening ? { at: isOpening ? 0 : approxJoin, leftAt: 0, rightAt: 0 } : findVideoJoinEdges(result, approxJoin, rate);
    const newJoinAt = newJoin.at;
    const newLength = pullsToZero ? 0 : target.end - target.start;
    const expectedDuration = timelineDuration(timeline) + (oldLength - newLength);
    if (Math.abs(timelineDuration(result) - expectedDuration) > 1 / rate) throw unclear();
    if (!pullsToZero) {
      // Verify the footage still plays cleanly right up to the adjusted join on `before`'s clock. Compare against the
      // pre-adjustment join map when available so a later whole-track picture-sync offset doesn't cause a false mismatch.
      const beforeDur = timelineDuration(before);
      const oldJoin = isOpening ? { at: 0, leftAt: 0, rightAt: 0 } : findVideoJoinEdges(timeline, cut.at, rate);
      const backBefore = makeTimeMap(timeline, before, rate);
      const oldLeft = !isOpening && oldJoin.leftAt > 0.5 / rate ? backBefore(oldJoin.leftAt, "left") : 0;
      const oldRight = !isClosing && oldJoin.rightAt < dur - 0.5 / rate ? backBefore(oldJoin.rightAt, "right") : beforeDur;
      const back = makeTimeMap(result, before, rate);
      const leftEdge = !isOpening && newJoin.leftAt > 0.5 / rate ? back(newJoin.leftAt, "left") : 0;
      const rightEdge = !isClosing && newJoin.rightAt < timelineDuration(result) - 0.5 / rate ? back(newJoin.rightAt, "right") : beforeDur;
      const expectedLeft = oldLeft !== null ? oldLeft + deltaStart : target.start;
      const expectedRight = oldRight !== null ? oldRight + deltaEnd : target.end;
      if (leftEdge === null || rightEdge === null || Math.abs(leftEdge - expectedLeft) > 1.5 / rate || Math.abs(rightEdge - expectedRight) > 1.5 / rate) {
        throw unclear();
      }
    }
    const prior = ctx.repos.changes.get(cut.changeId);
    const priorNamed = prior?.timelineEdits?.[cut.spot];
    const author = actorFor(user);
    const id = newId("chg");
    const description = pullsToZero ? `Rejected · ${cut.label}` : `Adjusted · ${cut.label}`;
    const saved = storeVersion(ctx, projectId, result, { parent: head, author, description, changeId: id });
    const change: Change = {
      id,
      projectId,
      description,
      author,
      decidedBy: author,
      state: "approved",
      threadId,
      ...(pullsToZero && { rejects: true as const }),
      fromVersion: head,
      toVersion: saved.version,
      appliedOnto: head,
      appliedVersion: saved.version,
      timelineEdits: [{
        label: cut.label.slice(0, 180),
        range: pullsToZero ? { start: cut.at, end: cut.at + oldLength } : { start: newJoinAt, end: newJoinAt },
        ...(priorNamed?.reason && { reason: priorNamed.reason }),
        ...(priorNamed?.summary && { summary: priorNamed.summary }),
        ...(priorNamed?.check && { check: priorNamed.check }),
        replaces: { changeId: cut.changeId, spot: cut.spot },
      }],
      ...(!pullsToZero && { leftOut: { version: cut.before.version, joins: [{ at: newJoinAt, removed: { start: target.start, end: target.end } }] } }),
      noteIds: [],
      renders: [],
      ranges: diffTimelines(timeline, saved, rate).ranges,
      createdAt: now(),
      updatedAt: now(),
    };
    ctx.repos.changes.put(change);
    const updated = ctx.repos.projects.update(projectId, { head: saved.version });
    ctx.bus.publish({ type: "change.updated", projectId, change });
    ctx.bus.publish({ type: "project.updated", projectId, project: updated });
    logActivity(ctx, {
      projectId,
      actor: author,
      type: pullsToZero ? "change.undone" : "change.adjusted",
      summary: description,
      data: {
        changeId: id,
        threadId,
        replaces: { changeId: cut.changeId, spot: cut.spot },
        from: head,
        version: saved.version,
        branch,
        removedBefore: oldRemoved,
        removedAfter: target,
        durationBefore: timelineDuration(timeline),
        durationAfter: timelineDuration(saved),
      },
    });
    return { project: updated, change };
  }, "immediate")();
}

/** A non-cut applied edit whose start/end edges the editor dragged directly on the timeline. */
export interface AdjustedEditTarget {
  changeId: string;
  spot: number;
  label: string;
  range: TimeRange;
  kind?: string;
}

function changeClipIds(change: Change | null | undefined): string[] | undefined {
  if (!change?.ops?.length) return undefined;
  const ids = new Set<string>();
  for (const op of change.ops) {
    if (op.op === "addClip" && op.clip && typeof op.clip === "object" && typeof (op.clip as { id?: unknown }).id === "string") {
      ids.add((op.clip as { id: string }).id);
    } else if (op.op === "updateClip" && typeof op.clipId === "string") {
      ids.add(op.clipId);
    }
  }
  return ids.size ? [...ids] : undefined;
}

/**
 * Adjust any non-cut applied edit's start/end edges directly with no model: captions, B-roll, graphics, overlays,
 * added audio clips, split-clip zooms/reframes/voice edits, music dips, and J/L split edits.
 * Refuses (`needs_scarlet`) where the edit cannot be adjusted cleanly without Scarlet.
 */
export function adjustAppliedEdit(ctx: Ctx, user: User, projectId: string, threadId: string, edit: AdjustedEditTarget,
  nextRange: TimeRange, expectedHead: string, branch: string) {
  return ctx.db.transaction(() => {
    const project = ensureProjectHead(ctx, projectId);
    const { head } = project, timeline = resolveTimeline(ctx, project);
    if (head !== expectedHead || project.branch !== branch) throw conflict("cut_changed", "The video changed. Try again.");
    const rate = project.settings.fps;
    const unclear = () => conflict("needs_scarlet", "This edit can’t be adjusted directly. Use Revise instead.");
    const target = alignMovedEdges(edit.range, nextRange, rate);
    const media = ctx.repos.projects.get(projectId)?.media;
    const prior = ctx.repos.changes.get(edit.changeId);
    const priorNamed = prior?.timelineEdits?.[edit.spot];
    const clipIds = changeClipIds(prior);
    const result = adjustEdit(timeline, edit.range, target, rate, media, { kind: edit.kind, clipIds });
    if (!result) throw unclear();

    const author = actorFor(user);
    const id = newId("chg");
    const rejected = !!result.removed;
    const description = rejected ? `Rejected · ${edit.label}` : `Adjusted · ${edit.label}`;
    const saved = storeVersion(ctx, projectId, result.timeline, { parent: head, author, description, changeId: id });
    const change: Change = {
      id,
      projectId,
      description,
      author,
      decidedBy: author,
      state: "approved",
      threadId,
      ...(rejected && { rejects: true as const }),
      fromVersion: head,
      toVersion: saved.version,
      appliedOnto: head,
      appliedVersion: saved.version,
      ops: result.ops as unknown as Array<Record<string, unknown>>,
      timelineEdits: [{
        label: edit.label.slice(0, 180),
        range: rejected ? edit.range : result.range,
        ...(priorNamed?.reason && { reason: priorNamed.reason }),
        ...(priorNamed?.summary && { summary: priorNamed.summary }),
        ...(priorNamed?.check && { check: priorNamed.check }),
        replaces: { changeId: edit.changeId, spot: edit.spot },
      }],
      noteIds: [],
      renders: [],
      ranges: diffTimelines(timeline, saved, rate).ranges,
      createdAt: now(),
      updatedAt: now(),
    };
    ctx.repos.changes.put(change);
    const updated = ctx.repos.projects.update(projectId, { head: saved.version });
    ctx.bus.publish({ type: "change.updated", projectId, change });
    ctx.bus.publish({ type: "project.updated", projectId, project: updated });
    logActivity(ctx, {
      projectId,
      actor: author,
      type: rejected ? "change.undone" : "change.adjusted",
      summary: description,
      data: {
        changeId: id,
        threadId,
        replaces: { changeId: edit.changeId, spot: edit.spot },
        from: head,
        version: saved.version,
        branch,
        rangeBefore: edit.range,
        rangeAfter: result.range,
        durationBefore: timelineDuration(timeline),
        durationAfter: timelineDuration(saved),
      },
    });
    return { project: updated, change };
  }, "immediate")();
}
