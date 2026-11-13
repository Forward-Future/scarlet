import { createHash } from "node:crypto";
import { contentHash, emptyTimeline, stableStringify, Id, WritableTimeline, type Author, type Project, type Timeline } from "@scarlet/timeline";
import type { Ctx } from "../context.js";
import { now } from "../db.js";
import { badRequest, notFound } from "../errors.js";

/** Version id: first 16 hex of sha256 of the stable JSON of the timeline content. */
export function versionIdFor(tl: Timeline): string {
  const { version, parent, createdAt, ...content } = tl;
  return createHash("sha256").update(stableStringify(content)).digest("hex").slice(0, 16);
}

/**
 * Store a timeline as an immutable version. Same content → same id; an
 * existing version is returned untouched (first writer wins on parent).
 */
type VersionMeta = { parent: string | null; author?: Author; changeId?: string | null; description?: string };

export function storeVersion(ctx: Ctx, projectId: string, input: Timeline, meta: VersionMeta): Timeline {
  return storeValidatedVersion(ctx, WritableTimeline.parse({ ...input, projectId }), meta);
}

/** The proposal path has already applied WritableTimeline validation. Hash its result once. */
export function storeValidatedVersion(ctx: Ctx, normalized: Timeline, meta: VersionMeta, differentFrom?: Timeline): Timeline {
  const { projectId } = normalized;
  const content = versionIdFor(normalized);
  if (differentFrom && content === versionIdFor(differentFrom)) throw badRequest("no_change", "the proposed timeline is identical to fromVersion");
  // Identical footage can be reached by different edits on different branches.
  const version = meta.changeId
    ? contentHash({ content, parent: meta.parent, changeId: meta.changeId }).slice(0, 16)
    : content;
  const existing = ctx.repos.versions.get(projectId, version);
  if (existing) return existing.timeline;
  const tl = { ...normalized, version, parent: Id.nullable().parse(meta.parent), createdAt: now() };
  return ctx.repos.versions.insert({
    version,
    projectId,
    parent: meta.parent,
    timeline: tl,
    author: meta.author,
    changeId: meta.changeId ?? null,
    description: meta.description,
    createdAt: tl.createdAt!,
  }).timeline;
}

/** Resolve "head" / a version id / undefined to a timeline. No head → emptyTimeline. */
export function resolveTimeline(ctx: Ctx, project: Pick<Project, "id" | "head">, version?: string | null): Timeline {
  const v = !version || version === "head" ? project.head : version;
  if (!v) {
    if (version && version !== "head") throw notFound(`version ${version}`);
    return emptyTimeline(project.id);
  }
  const row = ctx.repos.versions.get(project.id, v);
  if (!row) throw notFound(`version ${v}`);
  return row.timeline;
}

/** Make sure the project has a concrete head version (stores the empty timeline on first use). */
export function ensureHead(ctx: Ctx, projectId: string): { project: Project; head: string; timeline: Timeline } {
  const project = ctx.repos.projects.get(projectId);
  if (!project) throw notFound("project");
  if (project.head) {
    const row = ctx.repos.versions.get(projectId, project.head);
    if (row) return { project, head: project.head, timeline: row.timeline };
  }
  const empty = storeVersion(ctx, projectId, emptyTimeline(projectId), {
    parent: null,
    author: { type: "scarlet", name: "Scarlet" },
    description: "Empty timeline",
  });
  ctx.repos.projects.initializeHead(projectId, project.head, empty.version);
  const current = ctx.repos.projects.get(projectId);
  if (!current?.head) throw notFound("project head");
  const timeline = current.head === empty.version ? empty : resolveTimeline(ctx, current);
  return { project: current, head: current.head, timeline };
}
