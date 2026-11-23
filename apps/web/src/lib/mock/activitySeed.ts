import { AGENT_LABEL } from "@scarlet/shared";
import type { ActivityEntry } from "@scarlet/shared";
import { newId } from "@scarlet/timeline";
import type { Author } from "@scarlet/timeline";
import type { MockDb } from "./fixtures";
import { now } from "./util";

/** History for the fixtures, so the log isn't empty in demo mode. Newest first. */
export function seedActivity(db: MockDb): ActivityEntry[] {
  const entries: ActivityEntry[] = [];
  const q = (t: string) => `“${t.length > 80 ? `${t.slice(0, 79)}…` : t}”`;
  const add = (projectId: string | null, actor: Author, type: string, summary: string, at: string | undefined, data: Record<string, unknown> = {}) =>
    entries.push({ id: newId("act"), projectId, actor, type, summary, data, createdAt: at ?? now() });
  for (const [pid, list] of Object.entries(db.media)) for (const m of list) add(pid, { type: "scarlet", name: "Scarlet" }, "media.added", `${q(m.name)} was added`, m.provenance?.createdAt ?? new Date(Date.now() - 86400000 * 2).toISOString(), { mediaId: m.id });
  for (const t of db.tasks) add(t.projectId, t.createdBy, "request.created", `${t.createdBy.name} asked ${AGENT_LABEL[t.agent]}: ${q(t.context.message ?? t.instruction)}`, t.createdAt, { taskId: t.id });
  for (const n of db.notes) add(n.projectId, n.author, "note.added", `${n.author.name} noted at ${Math.floor(n.time / 60)}:${String(Math.floor(n.time % 60)).padStart(2, "0")}: ${q(n.text)}`, n.createdAt, { noteId: n.id });
  for (const c of db.changes) {
    add(c.projectId, c.author, "change.proposed", `${c.author.name} proposed ${q(c.description)}`, c.createdAt, { changeId: c.id });
    const by = c.decidedBy ?? db.me;
    if (c.state === "approved") add(c.projectId, { type: "human", id: by.id, name: by.name }, "change.approved", `${by.name} approved ${q(c.description)}`, c.updatedAt, { changeId: c.id });
    if (c.state === "rejected") add(c.projectId, { type: "human", id: by.id, name: by.name }, "change.rejected", `${by.name} rejected ${q(c.description)}`, c.updatedAt, { changeId: c.id });
  }
  entries.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return entries;
}
