import { isAsideTask, PROJECT_EDIT_TASK_KINDS, queueBlocker, SIDE_CHECK_KINDS, type AgentHost, type QueueChange, type Task, type TaskKind } from "@scarlet/shared";
import type { Change } from "@scarlet/timeline";
import type { Ctx } from "../context.js";
import { now } from "../db.js";
import { conflict } from "../errors.js";
import { logId, since, throttledLog } from "../logText.js";
import { editsDialogue, FINISHED_TASK, pausedWork, saveTask } from "./tasks.js";

const queueLogs = new WeakMap<Ctx, ReturnType<typeof throttledLog>>();
const SIDE_CHECKS = `(${SIDE_CHECK_KINDS.map(kind => `'${kind}'`).join(",")})`;
/** What a pause of the project's editing holds back: its requests, and the reads of them for a rule, which run on Resume. */
const HELD_WHILE_PAUSED = `(${[...PROJECT_EDIT_TASK_KINDS, "learning_check"].map(kind => `'${kind}'`).join(",")})`;

function hostCanRun(host: AgentHost, task: Task): boolean {
  const agent = host.agents.find(a => a.id === task.agent && a.installed && a.loggedIn !== false);
  if (!agent) return false;
  if (task.model && agent.models && !agent.models.includes(task.model) && agent.model !== task.model) return false;
  if (!agent.modelOptions) return !task.effort && !task.serviceTier;
  const options = agent.modelOptions[task.model ?? agent.model ?? ""];
  return (!task.effort || !!options?.efforts.some(o => o.id === task.effort))
    && (!task.serviceTier || !!options?.speeds.some(o => o.id === task.serviceTier));
}

/**
 * Claim the oldest queued task this host can run (or a specific one). Null when none.
 *
 * `freeAgents` are the runtimes with a free request slot. A host that runs side checks in slots of their own also sends
 * `checkAgents`, the runtimes with a free check slot: requests then go only to `freeAgents` and side checks only to
 * `checkAgents`. A host that sends no `checkAgents` claims every kind from `freeAgents`, as before.
 */
export function claimTask(ctx: Ctx, host: AgentHost, taskId?: string, freeAgents?: string[], desktopPid?: number, checkAgents?: string[]): Task | null {
  return ctx.db.transaction(() => claimNext(ctx, host, taskId, freeAgents, desktopPid, checkAgents), "immediate")();
}

function claimNext(ctx: Ctx, host: AgentHost, taskId?: string, freeAgents?: string[], desktopPid?: number, checkAgents?: string[]): Task | null {
  if (taskId) {
    const target = ctx.repos.tasks.get(taskId);
    if (!target) return null;
    if (target.state !== "queued") throw conflict("not_queued", `task is ${target.state}`);
    if (!hostCanRun(host, target)) throw conflict("agent_unavailable", `host has no usable "${target.agent}" agent`);
  }
  const usable = (free?: string[]) => host.agents.filter(a => a.installed && a.loggedIn !== false && (!free || free.includes(a.id))).map(a => a.id);
  const agents = usable(freeAgents);
  const checkers = checkAgents && usable(checkAgents);
  if (!taskId && !agents.length && !checkers?.length) return null;
  const filter = taskId ? "q.id = ?" : checkers
    ? `q.kind != 'transcribe' AND ((q.kind NOT IN ${SIDE_CHECKS} AND q.agent IN (SELECT value FROM json_each(?)))
      OR (q.kind IN ${SIDE_CHECKS} AND q.agent IN (SELECT value FROM json_each(?))))`
    : "q.kind != 'transcribe' AND q.agent IN (SELECT value FROM json_each(?))";
  const filterArgs = taskId ? [taskId] : checkers ? [JSON.stringify(agents), JSON.stringify(checkers)] : [JSON.stringify(agents)];
  // Include only tasks this host can claim in the candidate scan. The shared queue still sees
  // requests for other hosts and requests being reworded, since they can hold up later work. A look at a frame or a
  // listen serves the run that asked for it, and starts only while that run is at work.
  const checkedAt = now();
  const rows = ctx.db.prepare(`SELECT q.id, q.project_id, q.kind, q.json, q.created_at, p.editing_paused,
    coalesce(json_extract(q.json, '$.rewordingUntil') > ?, 0) AS rewording FROM tasks q JOIN projects p ON p.id = q.project_id
    LEFT JOIN tasks root ON root.id = json_extract(q.json, '$.resumeRootId')
    LEFT JOIN tasks asker ON q.kind IN ('area_check', 'listen_check', 'hand_off') AND asker.id = json_extract(q.json, '$.context.checksTaskId')
    WHERE p.deleted_at IS NULL AND q.state = 'queued' AND ${filter}
    AND (p.editing_paused = 0 OR q.kind NOT IN ${HELD_WHILE_PAUSED})
    AND (q.kind NOT IN ('area_check', 'listen_check', 'hand_off') OR asker.state IN ('claimed', 'running')) AND q.kind != 'broll_make'
    ORDER BY coalesce(asker.state IN ('claimed', 'running'), 0) DESC,
      coalesce(root.created_at, q.created_at), coalesce(root.rowid, q.rowid), q.rowid`)
    .iterate(checkedAt, ...filterArgs) as Iterable<{
      id: string; project_id: string; kind: TaskKind; json: string; created_at: string; editing_paused: number; rewording: number;
    }>;
  // Only the columns the queue reads: an open pass's cut reasons are counted in SQL, never parsed, and an edit's
  // lineage is read only for a request about an applied edit.
  const lineage = ctx.db.prepare("SELECT json_extract(json, '$.timelineEdits') AS edits FROM changes WHERE id = ?");
  function readQueue(projectId: string, editingPaused: boolean) {
    const changes = (ctx.db.prepare(`SELECT id, project_id AS projectId, state, json_extract(json, '$.intent') AS intent,
        json_extract(json, '$.taskId') AS taskId, json_extract(json, '$.threadId') AS threadId,
        json_array_length(json_extract(json, '$.cutReasons')) AS cuts
      FROM changes WHERE project_id = ? AND state IN ('ready', 'revising')
        AND json_extract(json, '$.intent') = 'suggestion' AND json_array_length(json_extract(json, '$.cutReasons')) > 0`)
      .all(projectId) as (Omit<QueueChange, "cutReasons" | "taskId" | "threadId"> & { taskId: string | null; threadId: string | null; cuts: number })[])
      .map(({ cuts, taskId, threadId, ...change }): QueueChange =>
        ({ ...change, taskId: taskId ?? undefined, threadId: threadId ?? undefined, cutReasons: { length: cuts } }));
    const snapshot = ctx.repos.tasks.queue(projectId, changes.flatMap(change => change.taskId ? [change.taskId] : []));
    const tasks = editingPaused ? snapshot.filter(task => !editsDialogue(task.kind) || FINISHED_TASK.has(task.state)) : snapshot;
    const edits = new Map<string, Pick<Change, "id" | "timelineEdits"> | undefined>();
    const lookup = (id: string) => {
      if (!edits.has(id)) {
        const row = lineage.get(id) as { edits: string | null } | undefined;
        edits.set(id, row?.edits ? { id, timelineEdits: JSON.parse(row.edits) } : undefined);
      }
      return edits.get(id);
    };
    return { blocker: queueBlocker(tasks, editingPaused ? [] : changes, lookup),
      byId: new Map(tasks.map(task => [task.id, task])) };
  }
  const queues = new Map<string, ReturnType<typeof readQueue>>();
  const logBlocked = (row: { id: string; project_id: string; created_at: string }, reason: string, blocker?: string) => {
    const wait = Date.parse(checkedAt) - Date.parse(row.created_at);
    if (!(wait >= 30_000)) return;
    let write = queueLogs.get(ctx);
    if (!write) queueLogs.set(ctx, write = throttledLog(ctx.log, 60_000, 5000));  // One key per blocked queued request.
    write(`${row.id}/${reason}/${blocker ?? ""}`, `[task] claim_blocked task=${logId(row.id)} project=${logId(row.project_id)} reason=${reason} wait_ms=${wait}` +
      (blocker ? ` blocker=${logId(blocker)}` : ""));
  };
  for (const row of rows) {
    if (row.rewording) {
      logBlocked(row, "rewording");
      continue;
    }
    // A host that can't run the request never reads the project's queue for it.
    const task = ctx.repos.tasks.parse(row.json);
    if (!hostCanRun(host, task)) {
      logBlocked(row, "capability");
      continue;
    }
    if (!isAsideTask({ kind: row.kind })) {
      const queue = queues.get(row.project_id) ?? readQueue(row.project_id, row.editing_paused === 1);
      queues.set(row.project_id, queue);
      const candidate = queue.byId.get(row.id)!;
      const blocker = queue.blocker(candidate);
      if (blocker) {
        logBlocked(row, blocker.reason, blocker.id);
        continue;
      }
    }
    const createdAt = task.createdAt ?? row.created_at;
    const seenAt = now();
    const startedAt = task.startedAt && task.startedAt >= seenAt ? new Date(Date.parse(task.startedAt) + 1).toISOString() : seenAt;
    ctx.db.prepare("UPDATE tasks SET worker_pid = ?, worker_seen_at = ? WHERE id = ?").run(desktopPid, seenAt, task.id);
    const waited = since(createdAt, Date.parse(seenAt));
    ctx.log(`[task] ${task.id} claimed by ${host.name} (${host.id})${waited ? ` after ${waited} in the queue` : ""}`);
    return saveTask(ctx, { ...task, createdAt, state: "claimed", hostId: host.id, startedAt, workedMs: pausedWork(ctx, task) ?? 0, sessionRevokedFor: undefined });
  }
  return null;
}
