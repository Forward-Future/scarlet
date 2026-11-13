import { z } from "zod/v3";
import { ActivityEntry, AgentHost, Learning, QuickAction, Render, Skill, SkillVersion, Task, TaskEvent } from "@scarlet/shared";
import { Author, Change, Note, Transcript } from "@scarlet/timeline";
import { now, type Db } from "../db.js";
import { JsonStore } from "./store.js";
import { UsersRepo } from "./users.js";
import { ProjectsRepo } from "./projects.js";
import { VersionsRepo } from "./versions.js";
import { SettingsRepo, type DefaultProvider } from "./settings.js";
import { UsageRepo } from "./usage.js";

export const Notification = z.object({
  id: z.string(),
  userId: z.string(),
  title: z.string(),
  body: z.string().optional(),
  projectId: z.string().optional(),
  link: z.string().optional(),
  read: z.boolean().default(false),
  createdAt: z.string(),
});
export type Notification = z.infer<typeof Notification>;

/** Transcript plus the owning project (for the project_id index column). */
export const StoredTranscript = Transcript.extend({ projectId: z.string() });
export type StoredTranscript = z.infer<typeof StoredTranscript>;

const StoredTaskEvent = TaskEvent.extend({ id: z.string(), taskId: z.string(), at: z.string() });
export type StoredTaskEvent = z.infer<typeof StoredTaskEvent>;

const eventFilters = {
  all: "",
  conversation: " AND event_kind IN ('question','answer','log:editor_progress')",
  questionsAndAnswers: " AND event_kind IN ('question','answer')",
  mediaWaits: " AND event_kind = 'log:media_wait'",
  lastPlanOrAnswer: " AND event_kind IN ('plan','answer')",
};

export class TaskEventsRepo {
  constructor(private readonly db: Db) {}
  append(ev: StoredTaskEvent): StoredTaskEvent {
    const parsed = StoredTaskEvent.parse(ev);
    this.db
      .prepare("INSERT INTO task_events (id, task_id, json, at) VALUES (?, ?, ?, ?)")
      .run(parsed.id, parsed.taskId, JSON.stringify(parsed), parsed.at);
    return parsed;
  }
  list(taskId: string, view: keyof typeof eventFilters = "all"): StoredTaskEvent[] {
    const order = view === "lastPlanOrAnswer" ? " ORDER BY at DESC, rowid DESC LIMIT 1" : " ORDER BY at ASC, rowid ASC";
    // Otherwise SQLite may walk every event in time order to avoid sorting a few matching rows.
    const index = view === "all" ? "" : " INDEXED BY task_events_kind";
    const rows = this.db.prepare("SELECT json FROM task_events" + index + " WHERE task_id = ?" + eventFilters[view] + order).all(taskId) as Array<{
      json: string;
    }>;
    return rows.map((r) => StoredTaskEvent.parse(JSON.parse(r.json)));
  }
  /** Include empty conversations so opening a project needs no follow-up read for a quiet run. */
  conversations(taskIds: string[]): Record<string, StoredTaskEvent[]> {
    const byTask = Object.fromEntries(taskIds.map(id => [id, [] as StoredTaskEvent[]]));
    if (!taskIds.length) return byTask;
    const rows = this.db.prepare("SELECT task_id, json FROM task_events INDEXED BY task_events_kind WHERE task_id IN (SELECT value FROM json_each(?))"
      + eventFilters.conversation + " ORDER BY task_id, at, rowid").all(JSON.stringify(taskIds)) as { task_id: string; json: string }[];
    for (const row of rows) byTask[row.task_id]!.push(StoredTaskEvent.parse(JSON.parse(row.json)));
    return byTask;
  }
}

export class SkillVersionsRepo {
  constructor(private readonly db: Db) {}
  append(skillId: string, v: SkillVersion) {
    this.db
      .prepare("INSERT INTO skill_versions (skill_id, version, content, author, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(skillId, v.version, v.content, v.author ? JSON.stringify(v.author) : null, v.createdAt ?? now());
  }
  list(skillId: string): SkillVersion[] {
    const rows = this.db
      .prepare("SELECT * FROM skill_versions WHERE skill_id = ? ORDER BY version ASC")
      .all(skillId) as Array<{ version: number; content: string; author: string | null; created_at: string }>;
    return rows.map((r) =>
      SkillVersion.parse({
        version: r.version,
        content: r.content,
        author: r.author ? Author.parse(JSON.parse(r.author)) : undefined,
        createdAt: r.created_at,
      }),
    );
  }
  removeAll(skillId: string) {
    this.db.prepare("DELETE FROM skill_versions WHERE skill_id = ?").run(skillId);
  }
}

export function createRepos(db: Db, defaultProvider: DefaultProvider = "none") {
  const changes = new JsonStore<Change>(db, "changes", Change, (c) => ({
    project_id: c.projectId,
    state: c.state,
    created_at: c.createdAt ?? now(),
  }));
  const notes = new JsonStore<Note>(db, "notes", Note, (n) => ({
    project_id: n.projectId,
    state: n.state,
    created_at: n.createdAt ?? now(),
  }));
  const tasks = new JsonStore<Task>(db, "tasks", Task, (t) => ({
    project_id: t.projectId,
    kind: t.kind,
    agent: t.agent,
    state: t.state,
    host_id: t.hostId,
    created_at: t.createdAt ?? now(),
  }));
  return {
    users: new UsersRepo(db),
    projects: new ProjectsRepo(db, { changes, tasks, notes }),
    versions: new VersionsRepo(db),
    settings: new SettingsRepo(db, defaultProvider),
    transcripts: new JsonStore<StoredTranscript>(db, "transcripts", StoredTranscript, (t) => ({
      project_id: t.projectId,
      media_id: t.mediaId,
      created_at: t.createdAt ?? now(),
    })),
    changes,
    notes,
    learnings: new JsonStore<Learning>(db, "learnings", Learning, (l) => ({
      project_id: l.projectId,
      state: l.state,
      created_at: l.createdAt ?? now(),
    })),
    renders: new JsonStore<Render>(db, "renders", Render, (r) => ({
      project_id: r.projectId,
      key: r.key,
      version: r.version,
      kind: r.kind,
      state: r.state,
      created_at: r.createdAt ?? now(),
    })),
    tasks,
    taskEvents: new TaskEventsRepo(db),
    usage: new UsageRepo(db),
    hosts: new JsonStore<AgentHost>(db, "agent_hosts", AgentHost, (h) => ({
      user_id: h.userId,
      last_seen_at: h.lastSeenAt ?? null,
      created_at: h.lastSeenAt ?? now(),
    })),
    skills: new JsonStore<Skill>(db, "skills", Skill, (s) => ({
      name: s.name,
      scope: s.scope,
      owner_id: s.ownerId,
      project_id: s.projectId,
      created_at: s.createdAt ?? now(),
      updated_at: s.updatedAt ?? now(),
    })),
    skillVersions: new SkillVersionsRepo(db),
    activity: new JsonStore<ActivityEntry>(db, "activity", ActivityEntry, (a) => ({
      project_id: a.projectId,
      type: a.type,
      created_at: a.createdAt,
    })),
    actions: new JsonStore<QuickAction>(db, "quick_actions", QuickAction, (a) => ({
      scope: a.scope,
      owner_id: a.ownerId,
      created_at: a.createdAt ?? now(),
    })),
    notifications: new JsonStore<Notification>(db, "notifications", Notification, (n) => ({
      user_id: n.userId,
      read: n.read ? 1 : 0,
      created_at: n.createdAt,
    })),
  };
}

export type Repos = ReturnType<typeof createRepos>;
