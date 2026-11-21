import type { User } from "@scarlet/shared";
import { diffTimelines, HistoryConflict, makeTimeMap, newId, planRevert, putBackCut, putBackLooks, timelineDuration, type Change, type TimeRange } from "@scarlet/timeline";
import type { Ctx } from "../context.js";
import { now } from "../db.js";
import { conflict, notFound } from "../errors.js";
import { actorFor, logActivity } from "./activity.js";
import { ensureProjectHead, resolveTimeline, storeVersion } from "./timeline.js";

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
  at?: number; before?: { version: string; removed: TimeRange };
}

/**
 * Reject applied edits with no model, wherever the engine knows exactly what they changed. A cut's footage goes back at
 * its join. An edit of a change that only set how clips look or sound goes back to how those clips were. A change whose
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
      if (named?.length && named.length === spots.size && [...spots].every(spot => spot < named.length) && rejected.length === edits.length) {
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
        const next = range && putBackLooks(result, before, after, change.ops, range, named!.map(item => item.range), fps);
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
