import { Hono } from "hono";
import { z } from "zod/v3";
import { CompleteTaskRequest, CreateTaskRequest, queueWait, RecordTaskUsageRequest, RepeatAuditRequest, RewordTaskRequest, RunChoice, TaskEvent, TaskState, UsageGroupBy, type Task } from "@scarlet/shared";
import type { AppEnv } from "../auth.js";
import type { Ctx } from "../context.js";
import { badRequest, conflict, notFound } from "../errors.js";
import { waitFor } from "../events.js";
import { aboutStagedCut, appendTaskEvent, cancelTask, completeTask, createTask, followUpInstruction, holdForRewording, rewordTask, saveTask, startBeforeCalls, taskPrompt } from "../services/tasks.js";
import { readPassRepeats } from "../services/passRepeats.js";
import { callSentBack } from "../services/changes.js";
import { jsonBody, requireProjectHeader } from "./util.js";
import { actorFor, agentName, logActivity, quote } from "../services/activity.js";
import { continueWhenReady, interruptTask, retryTask } from "../services/taskRecovery.js";
import { requestAttempt, requireActiveAttempt } from "../services/taskAttempt.js";

function usageGroupBy(value: string | undefined, fallback: UsageGroupBy): UsageGroupBy {
  if (value === undefined || value === "") return fallback;
  const parsed = UsageGroupBy.safeParse(value);
  if (!parsed.success) throw badRequest("invalid_group", `by must be one of ${UsageGroupBy.options.join(", ")}`);
  return parsed.data;
}

export function taskRoutes(ctx: Ctx) {
  const r = new Hono<AppEnv>();

  function requireTask(taskId: string, projectId?: string) {
    const task = ctx.repos.tasks.get(taskId);
    if (!task || (projectId !== undefined && task.projectId !== projectId)) throw notFound(`task ${taskId}`);
    return task;
  }

  r.post("/projects/:id/tasks", async (c) => {
    const project = requireProjectHeader(ctx, c.req.param("id"));
    const body = await jsonBody(c, CreateTaskRequest);
    if (body.kind === "skill_from_change") throw badRequest("use_skill_from_change", "Create this task from an approved change with /skills/from-change");
    if (body.kind === "skill_edit") throw badRequest("use_skill_edit", "Ask for a change to a skill with /skills/:skillId/edit");
    if (body.kind === "learning_check") throw badRequest("not_a_request", "Scarlet starts this check itself, with each request.");
    const { mediaId, version } = body.context ?? {};
    if (mediaId && !ctx.db.prepare("SELECT 1 FROM media WHERE id = ? AND project_id = ?").get(mediaId, project.id)) {
      throw badRequest("unknown_media", "The selected footage does not belong to this project.");
    }
    if (version && version !== "head" && !ctx.repos.versions.exists(project.id, version)) {
      throw badRequest("unknown_version", "The selected edit version does not belong to this project.");
    }
    const user = c.var.user;
    const threadId = body.context?.threadId;
    const { changeId, cutIndex } = body.context ?? {};
    const aboutCut = aboutStagedCut(ctx, project.id, body.context ?? {});
    const instruction = (threadId ? followUpInstruction(ctx, project.id, threadId, body.instruction) : body.instruction) + aboutCut;
    // What the person said is the request itself, unless the app sent their words apart from what it asks of the
    // agent: Undo edit, pressed on an edit's card, reads "Undo" in the chat and tells the agent which edit to put back.
    // What was asked is then kept too, for the thread's later requests: "Undo" alone doesn't say which edit.
    const said = body.context?.message ?? body.instruction;
    const task = createTask(ctx, {
      projectId: project.id,
      kind: body.kind,
      agent: body.agent,
      model: body.model,
      effort: body.effort,
      fast: body.fast,
      serviceTier: body.serviceTier,
      instruction,
      context: { ...(body.context ?? {}), ...(threadId || aboutCut ? { message: said, asked: said === body.instruction ? undefined : body.instruction } : {}) },
      createdBy: actorFor(user),
    });
    // A pass set to apply when Scarlet finishes waits for a call the editor sends back, instead of applying over it.
    if (changeId && cutIndex !== undefined) ctx.db.transaction(() => callSentBack(ctx, task), "immediate")();
    logActivity(ctx, {
      projectId: project.id,
      actor: actorFor(user),
      type: "request.created",
      summary: `${user.name} asked ${agentName(task.agent)}: ${quote(task.context.message ?? body.instruction, 120)}${threadId ? " (follow-up)" : ""}`,
      data: { taskId: task.id, threadId: task.context.threadId },
    });
    return c.json({ task }, 201);
  });

  r.get("/projects/:id/tasks", (c) => {
    const project = requireProjectHeader(ctx, c.req.param("id"));
    const state = c.req.query("state");
    // A skill edit and a learning check only borrow the project to run in. Neither is part of its conversation.
    const tasks = state
      ? ctx.repos.tasks.select("project_id = ? AND kind NOT IN ('skill_edit', 'learning_check') AND state = ?", [project.id, TaskState.parse(state)], "created_at DESC")
      : ctx.repos.tasks.select("project_id = ? AND kind NOT IN ('skill_edit', 'learning_check')", [project.id], "created_at DESC");
    const conversation = c.req.query("events") === "conversation"
      ? ctx.repos.taskEvents.conversations(tasks.filter(t => t.kind !== "transcribe").map(t => t.id)) : undefined;
    return c.json({ tasks, conversation });
  });

  r.on("GET", ["/tasks/:taskId", "/projects/:projectId/tasks/:taskId"], async (c) => {
    const id = c.req.param("taskId");
    const task = requireTask(id, c.req.param("projectId"));
    if (c.req.query("wait") === "transcript") {
      // The transcript is saved once it has its words, while the task goes on to align them. A reader waits for the words.
      const readable = (t: Task) => (t.progress?.words?.fraction ?? 0) >= 1;
      if (task.kind === "transcribe" && task.state === "running" && !readable(task) && ctx.transcriptions.has(id)) {
        await waitFor(ctx.bus, "ws", 10_000, e => e.type === "task.updated" && e.task.id === id && (e.task.state !== "running" || readable(e.task)),
          AbortSignal.any([ctx.shutdown, c.req.raw.signal]));
        return c.json({ task: requireTask(id, c.req.param("projectId")), waited: true });
      }
      return c.json({ task });
    }
    return c.json({ task, checksTaskAttempts: true, events: ctx.repos.taskEvents.list(task.id, c.req.query("events") === "conversation" ? "conversation" : "all") });
  });

  // Called by agent hosts before each run. workDir is the task artifact directory on the host; timeLimit is the run's limit in minutes.
  r.on("GET", ["/tasks/:taskId/prompt", "/projects/:projectId/tasks/:taskId/prompt"], (c) => {
    const { workDir, fresh, timeLimit } = z.object({ workDir: z.string().max(4096).regex(/^[^\r\n]*$/).optional(), fresh: z.enum(["1", "true"]).optional(),
      timeLimit: z.coerce.number().int().positive().max(24 * 60).optional() })
      .parse({ workDir: c.req.query("workDir") || undefined, fresh: c.req.query("fresh") || undefined, timeLimit: c.req.query("timeLimit") || undefined });
    return c.json(taskPrompt(ctx, requireTask(c.req.param("taskId"), c.req.param("projectId")), { workDir, fresh: !!fresh, timeLimitMinutes: timeLimit }));
  });

  r.post("/tasks/:taskId/cancel", (c) => {
    return c.json(ctx.db.transaction(() => ({ task: cancelTask(ctx, requireTask(c.req.param("taskId"))) }), "immediate")());
  });

  // The editor is changing the words of a request still waiting its turn: it doesn't start until they're saved.
  r.post("/tasks/:taskId/hold", async (c) => {
    const { on } = await jsonBody(c, z.object({ on: z.boolean() }));
    return c.json(ctx.db.transaction(() => ({ task: holdForRewording(ctx, requireTask(c.req.param("taskId")), on) }), "immediate")());
  });

  // The editor starts a request the calls of a dialogue pass hold back, without making those calls first.
  r.post("/tasks/:taskId/start-now", (c) => {
    return c.json(ctx.db.transaction(() => ({ task: startBeforeCalls(ctx, c.var.user, requireTask(c.req.param("taskId"))) }), "immediate")());
  });

  r.post("/tasks/:taskId/reword", async (c) => {
    const { text, skillIds } = await jsonBody(c, RewordTaskRequest);
    return c.json(ctx.db.transaction(() => ({ task: rewordTask(ctx, c.var.user, requireTask(c.req.param("taskId")), text, skillIds) }), "immediate")());
  });

  r.post("/tasks/:taskId/retry", async (c) => c.json({ task: retryTask(ctx, c.req.param("taskId"), await jsonBody(c, RunChoice)) }));

  r.post("/tasks/:taskId/continue-when-ready", async (c) => {
    const { on } = await jsonBody(c, z.object({ on: z.boolean() }));
    return c.json(continueWhenReady(ctx, c.req.param("taskId"), on));
  });

  r.post("/tasks/:taskId/answer", async (c) => {
    const body = await jsonBody(c, z.object({ text: z.string().min(1), skillIds: z.array(z.string().min(1)).optional() }));
    // The answer, the requeue and its activity entry land together, after the state check.
    const updated = ctx.db.transaction(() => {
      const task = requireTask(c.req.param("taskId"));
      if (body.skillIds?.length) task.context.skillIds = [...new Set([...(task.context.skillIds ?? []), ...body.skillIds])];
      const { task: updated } = appendTaskEvent(ctx, task, { type: "answer", text: body.text });
      logActivity(ctx, { projectId: task.projectId, actor: actorFor(c.var.user), type: "question.answered", summary: `${c.var.user.name} answered ${agentName(task.agent)}: ${quote(body.text, 120)}`, data: { taskId: task.id, threadId: task.context.threadId, question: task.question } });
      return updated;
    }, "immediate")();
    return c.json({ task: updated });
  });

  // Called by agent hosts
  r.on("POST", ["/tasks/:taskId/question", "/projects/:projectId/tasks/:taskId/question"], async (c) => {
    const { startedAt, text, sessionId } = await jsonBody(c, z.object({ startedAt: z.string().datetime().optional(), text: z.string().min(1),
      sessionId: z.string().min(1).max(200).nullable().optional() }));
    const waiting = ctx.db.transaction(() => {
      let task = requireTask(c.req.param("taskId"), c.req.param("projectId"));
      // A lost response may be retried by the MCP process or its host, even after an answer and a new claim.
      if (task.startedAt !== startedAt) return false;
      if (task.state === "claimed" || task.state === "running") task = appendTaskEvent(ctx, task, { type: "question", text }).task;
      const waiting = task.state === "waiting_for_user";
      // Only the host knows the CLI session that asked; the MCP server's copy leaves it alone.
      // An answer may already have re-queued this claim.
      if (sessionId !== undefined && (waiting || task.state === "queued") && task.session?.id !== (sessionId ?? undefined)) {
        saveTask(ctx, { ...task, session: sessionId ? { agent: task.agent, id: sessionId } : undefined });
      }
      return waiting;
    }, "immediate")();
    return c.json({ waiting });
  });

  r.on("POST", ["/tasks/:taskId/events", "/projects/:projectId/tasks/:taskId/events"], async (c) => {
    const { startedAt, ...body } = await jsonBody(c, TaskEvent.extend({ startedAt: z.string().datetime().optional() }));
    // An event can change the task's state; write both against the task as it is now.
    ctx.db.transaction(() => {
      const task = requireTask(c.req.param("taskId"), c.req.param("projectId"));
      requireActiveAttempt(ctx, requestAttempt(c.req.raw) ?? { taskId: task.id, startedAt }, task.projectId, task.id);
      appendTaskEvent(ctx, task, body);
    }, "immediate")();
    return c.json({});
  });

  // Reported once per run, whatever its outcome, so pauses for a question and failures still count.
  r.on("POST", ["/tasks/:taskId/usage", "/projects/:projectId/tasks/:taskId/usage"], async (c) => {
    const { startedAt, ...usage } = await jsonBody(c, RecordTaskUsageRequest);
    const task = requireTask(c.req.param("taskId"), c.req.param("projectId"));
    ctx.repos.usage.record(task, usage, startedAt);
    ctx.bus.publish({ type: "task.usage", projectId: task.projectId, taskId: task.id, usage: ctx.repos.usage.taskTotals(task.id) });
    return c.json({});
  });

  r.get("/projects/:id/usage", (c) => {
    const project = requireProjectHeader(ctx, c.req.param("id"));
    return c.json(ctx.repos.usage.summary(usageGroupBy(c.req.query("by"), "thread"), project.id));
  });

  r.get("/usage", (c) => c.json(ctx.repos.usage.summary(usageGroupBy(c.req.query("by"), "project"))));

  r.post("/projects/:projectId/tasks/:taskId/repeat-audit", async c => {
    const task = requireTask(c.req.param("taskId"), c.req.param("projectId"));
    const body = await jsonBody(c, RepeatAuditRequest);
    requireActiveAttempt(ctx, requestAttempt(c.req.raw) ?? { taskId: task.id, startedAt: body.startedAt }, task.projectId, task.id);
    return c.json(await readPassRepeats(ctx, task, body, c.req.raw.signal));
  });

  // What quitting would stop, in every project out of the trash: the desktop app asks before it closes on any of it.
  r.get("/under-way", (c) => {
    const count = (sql: string) => (ctx.db.prepare(sql).get() as { n: number }).n;
    const live = "project_id IN (SELECT id FROM projects WHERE deleted_at IS NULL)";
    const requests = `kind IN ('edit','note','revise') AND ${live}`;
    // Quitting stops a skill Scarlet writes or revises too, and it carries on at the next launch as a request does.
    // A learning check isn't run again, and the request it reads is counted already.
    const runs = `kind IN ('edit','note','revise','skill_edit','skill_from_change') AND ${live}`;
    // A request held for the editor's answer or calls waits on them, not on Scarlet, so quitting holds up nothing of it.
    const queued = ctx.repos.tasks.select(`state = 'queued' AND ${requests}`);
    let waiting = 0;
    for (const projectId of new Set(queued.map(t => t.projectId))) {
      const tasks = ctx.repos.tasks.select("project_id = ?", [projectId], "created_at, rowid");
      const changes = ctx.repos.changes.select("project_id = ?", [projectId]);
      waiting += queued.filter(t => t.projectId === projectId && !["question", "review"].includes(queueWait(t, tasks, changes)?.kind ?? "")).length;
    }
    return c.json({
      edits: count(`SELECT count(*) AS n FROM tasks WHERE ${runs} AND state IN ('claimed','running')`),
      queued: waiting,
      exports: count(`SELECT count(*) AS n FROM renders WHERE ${live} AND state IN ('queued','running') AND json_extract(json, '$.export.owner') IS NOT NULL`),
    });
  });

  r.post("/tasks/:taskId/complete", async (c) => {
    const body = await jsonBody(c, CompleteTaskRequest);
    const id = c.req.param("taskId");
    if (body.state === "cancelled" && body.interrupted) return c.json({ task: interruptTask(ctx, id, body.ifStartedAt, !body.engineLost) });
    const updated = ctx.db.transaction(() => {
      const task = requireTask(id);
      if (body.ifStartedAt && (task.startedAt !== body.ifStartedAt || !["claimed", "running"].includes(task.state))) return task;
      return completeTask(ctx, task, body);
    }, "immediate")();
    return c.json({ task: updated });
  });

  return r;
}
