import { AGENT_LABEL, type ActivityEntry, type User } from "@scarlet/shared";
import { newId, type Author } from "@scarlet/timeline";
import type { Ctx } from "../context.js";
import { now } from "../db.js";

/** A person, or Scarlet itself for automatic actions. */
export function actorFor(user: User | null | undefined): Author {
  return user ? { type: "human", id: user.id, name: user.name } : { type: "scarlet", name: "Scarlet" };
}

/**
 * Record something that happened. Entries are never edited or deleted (except
 * when a trashed project is purged after 30 days), so the log is the full
 * history of a project: every change and decision, including undos.
 */
export function logActivity(
  ctx: Ctx,
  input: { projectId: string | null; actor: Author; type: string; summary: string; data?: Record<string, unknown> },
): ActivityEntry {
  const entry = ctx.repos.activity.put({
    id: newId("act"),
    projectId: input.projectId,
    actor: input.actor,
    type: input.type,
    summary: input.summary,
    data: input.data ?? {},
    createdAt: now(),
  });
  ctx.bus.publish({ type: "activity.added", projectId: entry.projectId, entry });
  return entry;
}

/** What an agent is called in a summary: its name in the interface ("Claude Code"), never its id or its model's. */
export function agentName(agent: string): string {
  return (AGENT_LABEL as Record<string, string>)[agent] ?? agent;
}

/** Who a summary says did something: an agent by its name in the interface, anyone else by their own. */
export function authorName(author: Author): string {
  return author.type === "agent" ? (AGENT_LABEL as Record<string, string>)[author.id ?? author.name] ?? author.name : author.name;
}

/** Short quote for summaries. */
export function quote(text: string, max = 80): string {
  const t = text.replace(/\s+/g, " ").trim();
  return `“${t.length > max ? `${t.slice(0, max - 1)}…` : t}”`;
}
