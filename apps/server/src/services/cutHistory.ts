import type { User } from "@scarlet/shared";
import { diffTimelines, HistoryConflict, newId, planRevert, type Change } from "@scarlet/timeline";
import type { Ctx } from "../context.js";
import { now } from "../db.js";
import { conflict, notFound } from "../errors.js";
import { actorFor, logActivity } from "./activity.js";
import { ensureHead, resolveTimeline, storeVersion } from "./timeline.js";

export function recordHistoryEdit(ctx: Ctx, user: User, projectId: string, target: string,
  action: "revert" | "restore", expectedHead: string, branch: string) {
  return ctx.db.transaction(() => {
    const { project, head, timeline } = ensureHead(ctx, projectId);
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
      summary: description, data: { changeId: id, target, from: head, version: saved.version, branch } });
    return { project: updated, change };
  }, "immediate")();
}
