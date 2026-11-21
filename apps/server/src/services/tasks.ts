import { agentCapabilities, isAsideTask, SIDE_CHECK_KINDS, isLearningCheck, isProjectEditTask, PROJECT_EDIT_TASK_KINDS, isSkillEdit, planText, queueBlocker, type QueueChange, reviewItemPath, splitAgentTarget, TaskPlan, dialogueCommand, skillCommands, taskDialogueOperation, taskRunKind } from "@scarlet/shared";
import { AgentId, type AgentHost, type CompleteTaskRequest, type Task, type TaskEvent, type TaskKind, type TaskPrompt, type User } from "@scarlet/shared";
import { buildSystemPrompt } from "@scarlet/mcp/prompt";
import { join } from "node:path";
import { carriesAudio, describeDialogueRemovals, dialogueReceipt, dialogueRemovals, newId, type Author, type Change, type Project } from "@scarlet/timeline";
import { mimeFor, styleGuidePath } from "./graphics.js";
import type { Ctx } from "../context.js";
import { now } from "../db.js";
import { clip, logId, since, throttledLog } from "../logText.js";
import { badRequest, conflict, notFound } from "../errors.js";
import { recordTaskFinished, recordTaskRequested } from "../telemetry/events.js";
import { notify } from "./notify.js";
import { actorFor, agentName, logActivity, quote } from "./activity.js";
import { restoreUnreplacedProposal } from "./revisionState.js";
import { assistantSkills } from "./skills.js";
import { applyChoicesWhenDone, changeDiff, cutRevisionReference, passToRevise, retireStaleSaves } from "./changes.js";
import { resolveTimeline } from "./timeline.js";
import { runAttemptIds } from "./runAttempts.js";
import { learningCheckContext, skillEditEnded, startLearningCheck } from "./learnings.js";

/** States a task never leaves. */
export const FINISHED_TASK: ReadonlySet<string> = new Set(["done", "failed", "cancelled"]);
const queueLogs = new WeakMap<Ctx, ReturnType<typeof throttledLog>>();

/** Requests that can edit a project's video. */
export const PROJECT_EDIT_KINDS = `(${PROJECT_EDIT_TASK_KINDS.map(kind => `'${kind}'`).join(",")})`;
const SIDE_CHECKS = `(${SIDE_CHECK_KINDS.map(kind => `'${kind}'`).join(",")})`;

/** The recording has a saved transcript. */
export function hasTranscript(ctx: Ctx, mediaId: string): boolean {
  return !!ctx.db.prepare("SELECT 1 FROM transcripts WHERE media_id = ? LIMIT 1").get(mediaId);
}

/**
 * Recordings whose transcript or dialogue analysis the run waited for and never got, and whose transcript still
 * isn't saved. The MCP server records each wait and how it ended, so this is measured, not the agent's account.
 */
function unmetTranscriptWaits(ctx: Ctx, taskId: string): string[] {
  const met = new Map<string, boolean>();
  for (const ev of ctx.repos.taskEvents.list(taskId, "mediaWaits")) {
    const d = ev.data;
    if ((d?.wait !== "transcript" && d?.wait !== "dialogue") || typeof d.mediaId !== "string") continue;
    met.set(`${d.wait}/${d.mediaId}`, d.done === true && !d.failed);
  }
  const unmet = [...met].flatMap(([key, ok]) => ok ? [] : [key.slice(key.indexOf("/") + 1)]);
  return [...new Set(unmet)].filter(id => !hasTranscript(ctx, id));
}

/** "claude" | "claude:opus" | "codex/gpt-5-codex" → { agent, model }. */
export function parseAssignTo(value: string | undefined, fallback: AgentId): { agent: AgentId; model?: string } {
  if (!value) return { agent: fallback };
  const { agent: agentRaw, model } = splitAgentTarget(value);
  const parsed = AgentId.safeParse(agentRaw);
  if (!parsed.success) throw badRequest("invalid_agent", `unknown agent "${agentRaw}"; expected one of ${AgentId.options.join(", ")}`);
  return { agent: parsed.data, model };
}

/** Requests with the same kind, runtime, model and selected skills take comparable time. */
function recentDuration(ctx: Ctx, kind: TaskKind, agent: AgentId, model: string | undefined, skillIds: string[] | undefined): number | undefined {
  const key = (ids: string[] | undefined) => [...ids ?? []].sort().join("\n");
  const rows = ctx.db.prepare(`SELECT json_extract(json, '$.startedAt') AS start, json_extract(json, '$.finishedAt') AS finish,
      json_extract(json, '$.context.skillIds') AS skills
    FROM tasks WHERE state = 'done' AND kind = ? AND agent = ? AND json_extract(json, '$.model') IS ?
      AND NOT EXISTS (SELECT 1 FROM task_events WHERE task_id = tasks.id AND event_kind = 'question')
    ORDER BY created_at DESC LIMIT 50`).all(kind, agent, model ?? null) as { start: string; finish: string; skills: string | null }[];
  const seconds = rows.filter(r => key(r.skills ? JSON.parse(r.skills) as string[] : undefined) === key(skillIds)).slice(0, 5)
    .map(r => (Date.parse(r.finish) - Date.parse(r.start)) / 1000).filter(s => s > 0).sort((a, b) => a - b);
  if (seconds.length < 3) return;
  const middle = Math.floor(seconds.length / 2);
  return (seconds[middle]! + seconds[Math.floor((seconds.length - 1) / 2)]!) / 2;
}

export const editsDialogue = (kind: TaskKind) => isProjectEditTask({ kind });

/** Whether a request of this kind about one cut of `change` revises a staged cut: a revision does, and so does any request about a pass that waits or was replaced. */
export function stagesCut(kind: TaskKind, change: Change): boolean {
  return kind === "revise" || change.intent === "suggestion" && (["ready", "revising"].includes(change.state) || !!change.replacedBy);
}

function requestedDialogue(ctx: Ctx, text: string) {
  const names = skillCommands(text).map(command => command.name).filter(Boolean);
  if (names.length) return dialogueCommand(text, ctx.repos.skills.select("name IN (SELECT value FROM json_each(?))", [JSON.stringify(names)]));
}

/** Upgrade old requests and their answers once, before a host or the renderer reads them. */
export function migrateDialogueOperations(ctx: Ctx) {
  ctx.db.transaction(() => {
    const tasks = ctx.repos.tasks.select("kind IN ('edit','revise','note') AND json_type(json,'$.context.dialogueOperation') IS NULL", [], "created_at, rowid");
    const predecessors = new Map(tasks.flatMap(t => t.retryTaskId ? [[t.retryTaskId, t.id] as const] : []));
    for (const task of tasks) {
      const earlier = predecessors.get(task.id) ?? task.resumeRootId;
      const previous = earlier && ctx.repos.tasks.get(earlier);
      let operation = (previous && previous.context.dialogueOperation) || requestedDialogue(ctx, task.context.message ?? task.instruction) || "none";
      for (const event of ctx.repos.taskEvents.list(task.id, "questionsAndAnswers")) {
        if (event.type === "answer") operation = requestedDialogue(ctx, event.text) ?? operation;
      }
      ctx.repos.tasks.put({ ...task, repeatAudit: operation === "local-pauses" ? undefined : task.repeatAudit,
        context: { ...task.context, dialogueOperation: operation } });
    }
  }, "immediate")();
}

export function createTask(
  ctx: Ctx,
  input: {
    projectId: string;
    kind: TaskKind;
    agent: AgentId;
    model?: string;
    effort?: Task["effort"];
    fast?: boolean;
    serviceTier?: string;
    instruction: string;
    context?: Task["context"];
    createdBy: Author;
    state?: Task["state"];
    resumeRootId?: string;
    resumesAfterProjectStop?: boolean;
    stagedCutRevision?: boolean;
    cutConflict?: Task["cutConflict"];
  },
): Task {
  // "api" names the engine's own jobs, such as transcription. No host claims an editor's request for it.
  if (input.agent === "api" && input.createdBy.type === "human") throw badRequest("agent_unavailable", "Choose Claude, Codex or Gemini to run this request.");
  const id = newId("tsk");
  const selected = input.context?.cutIndex !== undefined && input.context.changeId ? ctx.repos.changes.get(input.context.changeId) : undefined;
  const task = ctx.repos.tasks.put({
    id,
    projectId: input.projectId,
    kind: input.kind,
    agent: input.agent,
    model: input.model,
    effort: input.effort,
    fast: input.fast || undefined,
    serviceTier: input.serviceTier,
    instruction: input.instruction,
    resumeRootId: input.resumeRootId,
    resumesAfterProjectStop: input.resumesAfterProjectStop,
    stagedCutRevision: input.stagedCutRevision ?? (selected && selected.projectId === input.projectId
      ? stagesCut(input.kind, selected) : undefined),
    cutConflict: input.cutConflict,
    expectedSeconds: recentDuration(ctx, input.kind, input.agent, input.model, input.context?.skillIds),
    context: { ...input.context, ...(input.context?.time !== undefined && (!input.context.version || input.context.version === "head") &&
      { version: ctx.repos.projects.header(input.projectId)?.head ?? undefined }), ...(editsDialogue(input.kind) && { dialogueOperation: input.context?.dialogueOperation ??
      requestedDialogue(ctx, input.context?.message ?? input.instruction) ?? "none" }), branch: input.context?.branch ?? ctx.repos.projects.header(input.projectId)?.branch, threadId: input.context?.threadId ?? id },
    state: input.state ?? "queued",
    createdBy: input.createdBy,
    hostId: null,
    changeIds: [],
    question: null,
    summary: null,
    createdAt: now(),
  });
  ctx.bus.publish({ type: "task.updated", projectId: task.projectId, task });
  if (task.state === "queued") ctx.bus.taskQueued({ taskId: task.id, projectId: task.projectId });
  recordTaskRequested(ctx, task);
  ctx.log(`[task] ${task.id} ${task.state}: ${task.kind} for ${task.agent}${task.model ? `/${task.model}` : ""}${task.effort ? ` (${task.effort})` : ""}` +
    ` in ${task.projectId}${task.context.threadId !== task.id ? `, thread ${task.context.threadId}` : ""}${task.resumeRootId ? `, resuming ${task.resumeRootId}` : ""}`);
  // What the editor said is read for a standing rule now, beside the request, so a rule reaches Learnings in seconds
  // and whether or not the request finishes.
  startLearningCheck(ctx, task);
  return task;
}

export function saveTask(ctx: Ctx, task: Task): Task {
  const finishedRevision = task.kind === "revise" && FINISHED_TASK.has(task.state);
  const persist = () => {
    const saved = ctx.repos.tasks.put(task);
    if (finishedRevision) restoreUnreplacedProposal(ctx, saved);
    ctx.bus.publish({ type: "task.updated", projectId: saved.projectId, task: saved });
    return saved;
  };
  return finishedRevision && !ctx.db.inTransaction ? ctx.db.transaction(persist, "immediate")() : persist();
}

/** Close the current claim's clock before it waits, requeues, or finishes. */
export function recordWorkThrough(task: Task, at: string): Task {
  if (!task.startedAt || (task.state !== "claimed" && task.state !== "running")) return task;
  const elapsed = Math.max(0, Date.parse(at) - Date.parse(task.startedAt));
  return { ...task, workedMs: (task.workedMs ?? 0) + elapsed };
}

/** On upgrade, retain the known part of a claim that already paused for a question. */
function pausedWork(ctx: Ctx, task: Task): number | undefined {
  const { startedAt, workedMs } = task;
  if (workedMs !== undefined || !startedAt) return workedMs;
  const question = ctx.repos.taskEvents.list(task.id, "questionsAndAnswers")
    .find(event => event.type === "question" && event.at >= startedAt);
  return question && Math.max(0, Date.parse(question.at) - Date.parse(startedAt));
}

/** A run saving a rule the editor approved in Learnings, where there is no message box to answer it from. */
const asksForARule = (task: Task) => isSkillEdit(task) && Boolean(task.context.learningId);

/**
 * A rule's save that can't go on without the editor saves nothing: the rule goes back to them in Learnings with the
 * question as why, and they answer it there by rewording the rule or approving it again.
 */
function returnRuleWithQuestion(ctx: Ctx, task: Task, question: string): Task {
  ctx.log(`[task] ${task.id} asked the editor a question while saving a rule; the rule goes back to them with it`);
  return completeTask(ctx, task, { state: "done", summary: question });
}

/** Saves an older engine left waiting on a question go back to the editor with it. */
export function returnRulesLeftWithQuestions(ctx: Ctx): void {
  for (const task of ctx.repos.tasks.select("kind = 'skill_edit' AND state = 'waiting_for_user' AND json_extract(json, '$.context.learningId') IS NOT NULL", [], "created_at, rowid")) {
    if (task.question) returnRuleWithQuestion(ctx, task, task.question);
  }
}

export function appendTaskEvent(ctx: Ctx, task: Task, ev: TaskEvent): { task: Task; event: TaskEvent } {
  if (FINISHED_TASK.has(task.state)) throw conflict("task_finished", `task is already ${task.state}`);
  if (ev.type === "answer" && task.state !== "waiting_for_user") throw conflict("no_question", "task is not waiting for an answer");
  if (ev.type === "plan") {
    // The agent's own plan, as its harness reported it. Scarlet keeps the steps and their states, and says them as text.
    const plan = TaskPlan.safeParse(ev.data);
    if (!plan.success) throw badRequest("invalid_plan", "a plan event carries data.steps, each with text and a state of pending, in_progress or done");
    // A harness repeats its plan, as Codex does when a turn ends. Only a change is recorded.
    const [last] = ctx.repos.taskEvents.list(task.id, "lastPlanOrAnswer");
    if (last?.type === "plan" && JSON.stringify(last.data) === JSON.stringify(plan.data)) return { task, event: last };
    ev = { ...ev, text: planText(plan.data.steps), data: plan.data };
  }
  const receivedAt = now();
  const event = ctx.repos.taskEvents.append({ ...ev, id: ev.id ?? newId("evt"), taskId: task.id, at: ev.at ?? receivedAt });
  if (ev.type === "question" && asksForARule(task)) {
    ctx.bus.publish({ type: "task.event", projectId: task.projectId, taskId: task.id, event });
    return { task: returnRuleWithQuestion(ctx, task, ev.text), event };
  }
  let next: Task = task;
  if (task.state === "claimed") next = { ...next, state: "running", startedAt: next.startedAt ?? receivedAt };
  if (ev.type === "question") {
    next = { ...recordWorkThrough(next, receivedAt), state: "waiting_for_user", question: ev.text };
    notify(ctx, `Agent question: ${ev.text.slice(0, 80)}`, {
      body: ev.text,
      projectId: task.projectId,
      link: reviewItemPath(task.projectId, task.id),
    });
  } else if (ev.type === "answer") {
    const operation = editsDialogue(task.kind) && requestedDialogue(ctx, ev.text);
    next = { ...next, workedMs: pausedWork(ctx, task), state: "queued", hostId: null, question: null,
      ...(operation && operation !== taskDialogueOperation(task) && { context: { ...task.context, dialogueOperation: operation, dialogueRange: undefined }, repeatAudit: undefined }),
      ...(task.cutConflict && { cutConflict: { ...task.cutConflict, answered: true, retried: undefined } }) };
  } else if (ev.type === "change" && typeof ev.data?.changeId === "string") {
    const id = ev.data.changeId;
    if (!next.changeIds.includes(id)) next = { ...next, changeIds: [...next.changeIds, id] };
  } else if (ev.type === "log" && ev.data?.kind === "init" && typeof ev.data.sessionId === "string" && ev.data.sessionId && RESUMABLE.has(task.agent)) {
    // The CLI session this run works in. A run cut short when Scarlet quits carries on in it.
    if (next.session?.id !== ev.data.sessionId) next = { ...next, session: { agent: task.agent, id: ev.data.sessionId } };
  }
  if (next !== task) next = saveTask(ctx, next);
  // What was asked and what was answered stay out of the log.
  if (next.state !== task.state) {
    ctx.log(`[task] ${task.id} ${task.state} → ${next.state}${ev.type === "question" ? ": asked the editor a question" : ev.type === "answer" ? ": the editor answered" : ""}`);
  }
  ctx.bus.publish({ type: "task.event", projectId: task.projectId, taskId: task.id, event });
  if (ev.type === "answer") ctx.bus.taskQueued({ taskId: task.id, projectId: task.projectId });
  return { task: next, event };
}

export function isDialoguePass(task: Task) {
  return editsDialogue(task.kind) && task.context.editIndex === undefined && task.context.cutIndex === undefined &&
    taskDialogueOperation(task) === "first-cut";
}

/** A pass that ends with outstanding findings on the version that plays runs again, as the same request, to resolve them. */
export function queueRepeatCheck(ctx: Ctx, task: Task, version: string, changeIds = task.changeIds) {
  const receipt = task.repeatAudit?.version === version ? task.repeatAudit : undefined;
  const closed = recordWorkThrough(task, now());
  // A previously finished pass may predate the persisted clock. Its latest claim is still measurable.
  const workedMs = closed.workedMs ?? pausedWork(ctx, task) ?? (task.startedAt && task.finishedAt
    ? Math.max(0, Date.parse(task.finishedAt) - Date.parse(task.startedAt)) : undefined);
  const queued = saveTask(ctx, { ...closed, workedMs, changeIds, state: "queued", hostId: null, session: undefined, finishedAt: undefined, error: undefined,
    repeatAudit: { ...receipt, version, noFindings: undefined, failed: undefined, returns: (receipt?.returns ?? 0) + 1 } });
  ctx.db.afterCommit(() => ctx.log(`[task] repeat_check task=${logId(task.id)} project=${logId(task.projectId)} outcome=queued attempt=${queued.repeatAudit!.returns}`));
  ctx.bus.taskQueued({ taskId: task.id, projectId: task.projectId });
  return queued;
}

export function completeTask(ctx: Ctx, task: Task, body: CompleteTaskRequest): Task {
  if (FINISHED_TASK.has(task.state)) {
    throw conflict("task_finished", `task is already ${task.state}`);
  }
  // A host can finish after an unsuccessful save. Keep the actual passage and the editor's answer
  // attached to this request even when the agent ended its turn without asking its own question.
  if (body.state === "done" && task.cutConflict) {
    if (task.state === "waiting_for_user") return task;
    if (!task.cutConflict.retried) {
      const queued = saveTask(ctx, { ...recordWorkThrough(task, now()), state: "queued", hostId: null, session: undefined,
        cutConflict: { ...task.cutConflict, retried: true } });
      ctx.db.afterCommit(() => ctx.log(`[task] completion_deferred task=${logId(task.id)} project=${logId(task.projectId)} outcome=queued reason=cut_changed`));
      ctx.bus.taskQueued({ taskId: queued.id, projectId: queued.projectId });
      return queued;
    }
    if (task.state === "queued") return task;
    if (!task.cutConflict.answered) {
      const asked = appendTaskEvent(ctx, task, { type: "question", text: task.cutConflict.range
        ? "The take here changed. Should I trim the current take or keep it as it plays?"
        : "The takes have changed. Which words should I keep here?" }).task;
      ctx.db.afterCommit(() => ctx.log(`[task] completion_deferred task=${logId(task.id)} project=${logId(task.projectId)} outcome=waiting_for_user reason=cut_changed`));
      return asked;
    }
    body = { state: "failed", error: "Scarlet could not finish the cut using your answer. Your answer is saved." };
  }
  if (task.kind === "skill_from_change" && body.state === "done" && !task.resultSkillId) {
    body = { state: "failed", error: "The requested skill was not saved. Request it again from the approved change." };
  }
  // The pass had finished and only its closing check was running (2026-11-18: Codex refused the check's sign-in). The
  // pass's work and words stand, so it finishes as done; the check that didn't run is said beside it, with Retry.
  const checkFailed = body.state === "failed" && !body.engineLost && isDialoguePass(task) && !!task.reply && !!task.repeatAudit
    ? body.error?.trim() || "The closing check stopped." : undefined;
  if (checkFailed) {
    task = { ...task, repeatAudit: { ...task.repeatAudit!, failed: checkFailed } };
    body = { state: "done", changeIds: body.changeIds };
  }
  const changeIds = [...new Set([...task.changeIds, ...(body.changeIds ?? [])])];
  const own = () => changeIds.flatMap(id => {
    const change = ctx.repos.changes.get(id);
    return change?.taskId === task.id && change.projectId === task.projectId ? [change] : [];
  });
  // The editor asked for their calls to apply as soon as the pass finished. Do it before a queued follow-up starts on the edit.
  if (body.state === "done") {
    const finished = { ...task, state: "done" as const };
    ctx.repos.tasks.put(finished);
    for (const change of own()) applyChoicesWhenDone(ctx, change);
    retireStaleSaves(ctx, task);
    // A run resumed after a quit may finish without saving another part. Its earlier attempts' pass still applies.
    const attempts = task.resumeRootId && runAttemptIds(task.projectId, task.resumeRootId);
    if (attempts) for (const change of ctx.repos.changes.select(`project_id = ? AND state = 'ready' AND json_extract(json, '$.taskId') IN (${attempts.sql})`,
        [task.projectId, ...attempts.params])) {
      if (change.taskId !== task.id) applyChoicesWhenDone(ctx, change);
    }
  }
  // Scheduled editor decisions above can advance playback too. The receipt must name the version that actually plays.
  if (body.state === "done" && !checkFailed && task.startedAt && (task.state === "claimed" || task.state === "running") && isDialoguePass(task)) {
    const project = ctx.repos.projects.get(task.projectId);
    if (project?.head && (!task.context.branch || project.branch === task.context.branch) && !unmetTranscriptWaits(ctx, task.id).length) {
      const timeline = resolveTimeline(ctx, project);
      const audible = new Set(project.media.filter(carriesAudio).map(m => m.id));
      const plays = timeline.tracks.some(t => !t.muted && t.clips.some(c => c.kind === "media" && c.enabled && c.volume > 0 && audible.has(c.mediaId)));
      const receipt = task.repeatAudit?.version === project.head ? task.repeatAudit : undefined;
      if (plays && (receipt?.remaining !== 0 || receipt.unavailable?.length)) {
        if (receipt?.unavailable?.length || (receipt?.returns ?? 0) >= 2) {
          body = { ...body, state: "failed", interrupted: true, error: receipt?.unavailable?.join(" ") ||
            "The final audio check still has repeats, silences or divided sentences to resolve. Resume to finish checking the saved edit." };
        } else {
          // The pass's closing words are kept for the editor while the check runs: the check's own are about the check.
          const reply = task.reply ?? (body.summary?.trim() || undefined);
          return queueRepeatCheck(ctx, reply ? { ...task, reply } : task, project.head, changeIds);
        }
      } else if (plays && receipt?.returns && receipt.noFindings) {
        // The automatic check finished on the same playback, with nothing for the editor. Keep the pass's own words.
        body = { ...body, summary: undefined };
      }
    }
  }
  const changes = body.state === "done" ? own() : [];
  const dialogue = changes.some(c => dialogueReceipt(c));
  // A pass saved in parts reports its removals once.
  const removals = changes.map(dialogueRemovals);
  const combined = removals.filter(Boolean).length > 1 ? describeDialogueRemovals(removals.flatMap(r => r ?? [])) : undefined;
  const summary = dialogue ? changes.flatMap((c, i) => {
    if (combined && removals[i]) return removals.findIndex(Boolean) === i ? [combined] : [];
    const receipt = dialogueReceipt(c);
    if (receipt) return [receipt];
    if (c.state === "approved") return [`Applied “${c.description.replace(/[.!?]$/, "")}”.`];
    if (c.state === "ready") return [`“${c.description.replace(/[.!?]$/, "")}” is pending review.`];
    return [];
  }).join(" ") : body.summary ?? task.summary;
  // The receipt takes a pass's summary, so what Scarlet said as it finished is kept beside it, for the editor.
  const reply = dialogue ? task.reply ?? (body.summary?.trim() || undefined) : task.reply;
  // The run finished without transcripts it waited for. What it saved stands, and the editor can resume it once they're ready.
  const needsTranscripts = body.state === "done" && task.kind !== "transcribe" ? unmetTranscriptWaits(ctx, task.id) : [];
  const finishedAt = now();
  const closed = recordWorkThrough(task, finishedAt);
  const saved = saveTask(ctx, {
    ...closed,
    workedMs: closed.workedMs ?? pausedWork(ctx, task),
    state: body.state,
    summary,
    ...(reply ? { reply } : {}),
    ...(needsTranscripts.length ? { needsTranscripts } : {}),
    error: body.error,
    changeIds,
    question: null,
    finishedAt,
    // The host stopped a stalled run. Its saved work stands, and the editor can resume it.
    ...(body.state === "failed" && body.interrupted ? { interrupted: true } : {}),
  });
  recordTaskFinished(ctx, saved);
  const ran = since(saved.startedAt, Date.parse(saved.finishedAt!));
  ctx.db.afterCommit(() => {
    ctx.log(`[task] ${saved.id} ${saved.state}${ran ? ` after ${ran}` : ""}${body.error ? `: ${clip(body.error, 400)}` : ""}` +
      `${changeIds.length ? ` (${changeIds.length} change${changeIds.length === 1 ? "" : "s"})` : ""}` +
      `${needsTranscripts.length ? `, without the transcript of ${needsTranscripts.join(", ")}` : ""}`);
    if (needsTranscripts.length) ctx.log(`[task] completion_deferred task=${logId(task.id)} project=${logId(task.projectId)} outcome=awaiting_transcripts reason=transcripts remaining=${needsTranscripts.length}`);
  });
  const asked = saved.context.message ?? saved.instruction.split("\n").pop() ?? saved.instruction;
  // A learning check is Scarlet's own reading of a request. What it offers is in Learnings; the run itself is no one's news.
  if (!isLearningCheck(saved)) logActivity(ctx, {
    projectId: isSkillEdit(saved) ? null : saved.projectId,
    actor: { type: "agent", id: saved.agent, name: saved.agent, model: saved.model },
    type: `request.${body.state}`,
    summary:
      body.state === "done"
        ? `${agentName(saved.agent)} finished ${quote(asked)}${changeIds.length ? ` and saved ${changeIds.length} edit${changeIds.length === 1 ? "" : "s"}` : ""}`
        : body.state === "failed"
          ? `${agentName(saved.agent)} couldn’t finish ${quote(asked)}${body.error ? `: ${body.error.slice(0, 160)}` : ""}`
          : `${agentName(saved.agent)} stopped working on ${quote(asked)}`,
    data: { taskId: saved.id, threadId: saved.context.threadId, changeIds },
  });
  // A rule the editor approved is saved now, or goes back to them, and the skill's next one starts.
  skillEditEnded(ctx, saved);
  // A follow-up queued behind this task in its thread can start now.
  ctx.bus.taskQueued({ taskId: saved.id, projectId: saved.projectId });
  // A skill's page says how its own request went, and a learning check says nothing.
  if (!isAsideTask(saved)) notify(ctx, body.state === "done" ? "Agent task finished" : `Agent task ${body.state}`, {
    body: body.state === "done" ? saved.summary ?? saved.instruction.slice(0, 120) : body.error ?? saved.instruction.slice(0, 120),
    projectId: saved.projectId,
    link: reviewItemPath(saved.projectId, saved.id),
  });
  return saved;
}

export function cancelTask(ctx: Ctx, task: Task): Task {
  if (FINISHED_TASK.has(task.state)) return task;
  const finishedAt = now();
  const closed = recordWorkThrough(task, finishedAt);
  const saved = saveTask(ctx, { ...closed, workedMs: closed.workedMs ?? pausedWork(ctx, task), state: "cancelled", finishedAt });
  recordTaskFinished(ctx, saved);
  const ran = since(task.startedAt, Date.parse(saved.finishedAt!));
  ctx.log(`[task] ${task.id} cancelled while ${task.state}${ran ? ` after ${ran}` : ""}`);
  ctx.db.afterCommit(() => ctx.transcriptions.get(task.id)?.controller.abort());
  skillEditEnded(ctx, saved);
  // A request taken back before it started is words withdrawn, as reworded ones are: a check still reading them stops.
  if (task.state === "queued" && task.kind !== "learning_check") {
    for (const check of ctx.repos.tasks.select("project_id = ? AND kind = 'learning_check' AND json_extract(json, '$.context.checksTaskId') = ?", [task.projectId, task.id])) {
      if (!FINISHED_TASK.has(check.state)) cancelTask(ctx, check);
    }
  }
  ctx.bus.taskQueued({ taskId: saved.id, projectId: saved.projectId });
  return saved;
}

/**
 * CLIs whose sessions Scarlet resumes after an answer or a quit. A Codex run keeps its thread in a private Codex home
 * beside its task folder, out of the user's own Codex thread list. Started afresh, a pass resumed after a quit spent
 * 120 more turns and 13.7M tokens finding its place again (2026-11-18).
 */
export const RESUMABLE = new Set<string>(["claude", "codex"]);

/** What a run hears when it carries on in its own CLI session after Scarlet closed on it. */
const INTERRUPTED = "Scarlet closed while you were working on this request, and it is open again. Carry on from where you stopped. " +
  "What you saved is kept. Read the current project and change states first: the editor may have decided some of it since.";

/** Pair each `question` event with the `answer` that followed it. */
export function pairQuestionsAndAnswers(events: Pick<TaskEvent, "type" | "text">[]): Array<{ question: string; answer: string }> {
  const out: Array<{ question: string; answer: string }> = [];
  let pending: string | null = null;
  for (const e of events) {
    if (e.type === "question") pending = e.text;
    else if (e.type === "answer" && pending !== null) {
      out.push({ question: pending, answer: e.text });
      pending = null;
    }
  }
  return out;
}

/**
 * What the agent is told. Every host fetches this, so there is one prompt.
 * After an answer, a host that still has the CLI session that asked continues
 * it with just the answer; otherwise the answers go in the system prompt.
 */
export function taskPrompt(ctx: Ctx, task: Task, opts: { workDir?: string; fresh?: boolean; timeLimitMinutes?: number } = {}): TaskPrompt {
  const project = ctx.repos.projects.get(task.projectId);
  if (!project) throw notFound("project");
  const c = task.context;
  const editSkill = isSkillEdit(task) ? ctx.repos.skills.get(c.skillId ?? "") : undefined;
  if (isSkillEdit(task) && !editSkill) throw notFound("the skill this request revises");
  const notes = c.noteIds?.length ? ctx.repos.notes.select("project_id = ? AND id IN (SELECT value FROM json_each(?))", [task.projectId, JSON.stringify(c.noteIds)]) : undefined;
  // A request about one staged cut names the pass as it stood when the editor sent it. A revision ahead of it in the
  // queue, or a later part of the pass, has replaced that pass since, so the agent is told about the pass that waits now
  // and the cut's index there.
  const named = c.changeId ? ctx.repos.changes.get(c.changeId) : undefined;
  const now = named?.projectId === task.projectId && c.cutIndex !== undefined ? passToRevise(ctx, named, task.id, c.cutIndex) : undefined;
  const record = now?.change ?? named;
  let change: { change: NonNullable<typeof record>; diff?: ReturnType<typeof changeDiff> } | undefined;
  if (record?.projectId === task.projectId) {
    try {
      change = { change: record, diff: changeDiff(ctx, record) };
    } catch (err) {
      ctx.log(`[task] ${task.id} is told about ${record.id} without its diff: ${(err as Error).message}`);
      change = { change: record };
    }
  }
  const events = ctx.repos.taskEvents.list(task.id, "questionsAndAnswers");
  const last = events.at(-1);
  const answered = last?.type === "answer";
  // A run interrupted before it finished carries on in the CLI session it was working in, when its host still has it.
  const interrupted = !last && !!task.resumeRootId;
  const resumeSession = !opts.fresh && (answered || interrupted) && task.session?.agent === task.agent && RESUMABLE.has(task.agent) ? task.session.id : undefined;
  // The run is launched with its harness's to-do tool, and asked to lay out its steps, when the harness has one and the
  // chat will show the plan. A dialogue pass shows the stages Scarlet measures and a request about one staged cut its
  // own two, and a skill edit changes no video: none is given the tool or asked, so each runs exactly as it did.
  const plans = task.kind !== "skill_from_change" && !isAsideTask(task) && !taskRunKind(task)
    && agentCapabilities(task.agent, (ctx.options.env ?? process.env).SCARLET_AGENT_CAPS).plan;
  const systemPrompt = buildSystemPrompt({
    project: { project, timeline: project.head ? resolveTimeline(ctx, project, "head") : null },
    task: now ? { ...task, context: { ...c, changeId: now.change.id, cutIndex: now.index } } : task,
    notes,
    change,
    replacedPass: now && named?.id,
    // A resumed session already holds the earlier questions and answers.
    qa: resumeSession ? undefined : pairQuestionsAndAnswers(events),
    skills: assistantSkills(ctx.repos.skills.select("1=1", [], "name ASC"), c.skillIds, true),
    editSkill: editSkill ?? undefined,
    learningCheck: isLearningCheck(task) ? learningCheckContext(ctx, task) : undefined,
    areaCheck: task.kind === "area_check" ? task.context.areaCheck : undefined,
    checkIn: ctx.settings().checkIn,
    workDir: opts.workDir,
    timeLimitMinutes: opts.timeLimitMinutes,
    capabilities: { ...agentCapabilities(task.agent), plan: plans },
    ...graphicsContext(ctx, project, task),
  });
  // Whether the host launches the CLI with its own to-do tool on.
  const plan = plans ? { plan: true } : {};
  if (isDialoguePass(task) && task.repeatAudit?.returns) {
    // The goal and what counts as done, not the steps: the tools say how they check and repair.
    const finish = "The dialogue pass has saved its editing work. What is left is the closing check on the current playback: " +
      "no word the cuts clipped should play, and each repeat, silence and divided sentence the check lists is cut, kept " +
      "with its reason, or staged for the editor when you doubt it, as the skill and the editor ask. " +
      "The pass is done once dialogue_check_repeats on the current version has nothing outstanding. " +
      "Honor the editor’s scope, preferences, protected footage and decisions.";
    return { systemPrompt, instruction: finish + "\nEditor’s request: " + firstMessage(task.instruction.trim()) +
      (answered ? "\nThe editor answered: " + last!.text : ""), ...plan };
  }
  return resumeSession
    ? { systemPrompt, instruction: answered ? `The editor answered: "${last!.text.trim()}"\nContinue the task with that answer.` : INTERRUPTED, resumeSession, ...plan }
    : { systemPrompt, instruction: firstMessage(task.instruction.trim()), ...plan };
}

/**
 * What the editor gave a request for its graphics: the files attached to it and the project's style guide. A request that edits no video is given none.
 */
function graphicsContext(ctx: Ctx, project: Project, task: Task) {
  if (task.kind === "skill_from_change" || isAsideTask(task)) return {};
  const attachments = (task.context.attachments ?? []).map(a => ({ ...a, mime: a.mime ?? mimeFor(a.name), path: join(ctx.paths.attachments(project.id), a.id, a.name) }));
  const guide = project.styleGuide;
  const guidePath = styleGuidePath(ctx, project.id, guide);
  return {
    ...(attachments.length && { attachments }),
    ...(guide && { styleGuide: { name: guide.name, text: guide.text, ...(guidePath && { path: guidePath, mime: mimeFor(guidePath) }) } }),
  };
}

/**
 * The request as a CLI's first message. Claude Code takes a message that begins with "/" for one of its own slash
 * commands. Finding none of that name, it tells the model the command did not run and to say it isn't installed, and
 * a pass then opened its reply with "The /first-cut-dialogue command isn't installed in this session" (2026-11-07).
 * A lead-in keeps the editor's words as typed and out of the CLI's command parser. The system prompt carries the
 * instruction as well, unchanged.
 */
function firstMessage(instruction: string) {
  return instruction.startsWith("/") ? `The editor's request: ${instruction}` : instruction;
}

/**
 * A follow-up in a thread that already has history: give the agent the gist of
 * what happened so far, keep what the person said in context.message. An earlier request the app worded for the
 * person reads as what it asked: its name in the chat, "Undo", doesn't say which edit was put back.
 */
export function followUpInstruction(ctx: Ctx, projectId: string, threadId: string, text: string, before?: string): string {
  const thread = ctx.repos.tasks.select("project_id = ? AND coalesce(json_extract(json, '$.context.threadId'), id) = ?", [projectId, threadId], "created_at ASC, rowid ASC");
  // A request reworded in the queue is told what came before it, as it was when first asked.
  const at = before ? thread.findIndex(t => t.id === before) : -1;
  const tasks = at < 0 ? thread : thread.slice(0, at);
  if (!tasks.length) return text;
  const [last] = ctx.repos.changes.select("project_id = ? AND json_extract(json, '$.threadId') = ?", [projectId, threadId], "created_at DESC, rowid DESC LIMIT 1");
  const lines = ["This continues an earlier request in the same thread."];
  for (const t of tasks) {
    lines.push(`- Asked: ${t.context.asked ?? t.context.message ?? t.instruction}`);
    if (t.summary) lines.push(`  You replied: ${t.summary}`);
  }
  if (last) lines.push(`Latest change: "${last.description}" (${last.state}).`);
  lines.push("", `Now: ${text}`);
  return lines.join("\n");
}

/**
 * What Scarlet told the editor about the one staged cut a request is about, as a revision sent from that cut's card
 * says it: why it was proposed and how it was assessed. A call can be sent back this way while its pass still runs.
 * Empty when the request isn't about one.
 */
export function aboutStagedCut(ctx: Ctx, projectId: string, context: Task["context"]): string {
  const { changeId, cutIndex, time } = context;
  const pass = changeId && cutIndex !== undefined && time !== undefined ? ctx.repos.changes.get(changeId) : undefined;
  return pass?.projectId === projectId ? cutRevisionReference(pass, { cutIndex, time: time!, end: context.end, clipIds: context.clipIds ?? [],
    version: context.version, mediaId: context.mediaId, markedRange: context.markedRange }) : "";
}

/** How long a hold for rewording lasts unless the app renews it, so a closed app can't keep a request from ever starting. */
const REWORDING_HOLD_MS = 90_000;

/**
 * Only a request that hasn't begun can have its words changed: a run that started has already read them. And only one
 * the editor asked: a request Scarlet made itself, such as a redo of a change that no longer fits, is told more than
 * the few words shown for it.
 */
function stillWaiting(task: Task): void {
  if (task.state !== "queued" || task.startedAt || task.resumeRootId) throw conflict("already_started", "Scarlet has already started on this request.");
  if (task.createdBy.type !== "human") throw conflict("not_yours", "This request is Scarlet’s own, so its words can’t be changed.");
}

/** Hold a queued request while the editor changes its words, or let it go. The requests behind it keep waiting for it. */
export function holdForRewording(ctx: Ctx, task: Task, on: boolean): Task {
  if (!on) {
    if (!task.rewordingUntil) return task;
    const saved = saveTask(ctx, { ...task, rewordingUntil: undefined });
    ctx.bus.taskQueued({ taskId: saved.id, projectId: saved.projectId });
    return saved;
  }
  stillWaiting(task);
  return saveTask(ctx, { ...task, rewordingUntil: new Date(Date.now() + REWORDING_HOLD_MS).toISOString() });
}

/**
 * Start a queued request without waiting for the editor's calls on a dialogue pass. It is the editor's word that the
 * request can run beside those calls, so it takes its turn like any request no pass holds back: after what Scarlet is
 * on and what is ahead of it in line.
 */
export function startBeforeCalls(ctx: Ctx, user: User, task: Task): Task {
  if (task.state !== "queued") throw conflict("already_started", "Scarlet has already started on this request.");
  if (task.startsBeforeCalls) return task;
  const saved = saveTask(ctx, { ...task, startsBeforeCalls: true });
  logActivity(ctx, { projectId: task.projectId, actor: actorFor(user), type: "request.started_early",
    summary: `${user.name} started a waiting request before making their calls: ${quote(task.context.message ?? task.instruction, 120)}`,
    data: { taskId: task.id, threadId: task.context.threadId } });
  ctx.log(`[task] ${task.id} told to start without waiting for the editor's calls`);
  ctx.bus.taskQueued({ taskId: saved.id, projectId: saved.projectId });
  return saved;
}

/**
 * Change what a waiting request asks, keeping its place in the queue. The agent is told it as if the editor had asked
 * it so: the instruction is built again the way it was when the request was sent, the note a revision or a new edit at
 * a point was sent as says it too, and the skills are the ones the new words name, as they'd be if sent so.
 */
export function rewordTask(ctx: Ctx, user: User, task: Task, text: string, skillIds?: string[]): Task {
  stillWaiting(task);
  const said = task.context.message ?? task.instruction;
  if (text === said) return holdForRewording(ctx, task, false);
  // A revision of a staged change has its words alone, then the cut it's about. Any other request has what came before
  // it in its thread too, which is nothing for one that began its thread.
  const words = task.kind === "revise" ? text : followUpInstruction(ctx, task.projectId, task.context.threadId ?? task.id, text, task.id);
  const instruction = words + aboutStagedCut(ctx, task.projectId, task.context);
  const message = task.context.message !== undefined ? { message: text } : {};
  // Reworded, the request is the editor's own words: what the app had worded for them, such as an undo, no longer stands.
  const skills = skillIds?.length ? [...new Set(skillIds)] : undefined;
  const saved = saveTask(ctx, { ...task, instruction, context: { ...task.context, ...message, skillIds: skills, asked: undefined,
    ...(editsDialogue(task.kind) && { dialogueOperation: requestedDialogue(ctx, text) ?? "none", dialogueRange: undefined }) }, rewordingUntil: undefined });
  // The prompt quotes a request's notes beside its instruction, so a note left with the old words would ask them still.
  for (const id of task.kind === "revise" || task.kind === "note" ? task.context.noteIds ?? [] : []) {
    const note = ctx.repos.notes.get(id);
    if (!note || note.text !== said) continue;
    const reworded = ctx.repos.notes.put({ ...note, text, voiceTranscript: undefined, updatedAt: now() });
    ctx.bus.publish({ type: "note.updated", projectId: reworded.projectId, note: reworded });
  }
  logActivity(ctx, { projectId: task.projectId, actor: actorFor(user), type: "request.reworded",
    summary: `${user.name} changed a waiting request to: ${quote(text, 120)}`, data: { taskId: task.id, threadId: task.context.threadId } });
  ctx.log(`[task] ${task.id} reworded while queued`);
  // The new words are read for a standing rule as the first were. A check still reading the old ones stops.
  for (const check of ctx.repos.tasks.select("project_id = ? AND kind = 'learning_check' AND json_extract(json, '$.context.checksTaskId') = ?", [task.projectId, task.id])) {
    if (!FINISHED_TASK.has(check.state)) cancelTask(ctx, check);
  }
  startLearningCheck(ctx, saved);
  ctx.bus.taskQueued({ taskId: saved.id, projectId: saved.projectId });
  return saved;
}

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
  // requests for other hosts and requests being reworded, since they can hold up later work.
  const checkedAt = now();
  const rows = ctx.db.prepare(`SELECT q.id, q.project_id, q.kind, q.json, q.created_at, p.editing_paused,
    coalesce(json_extract(q.json, '$.rewordingUntil') > ?, 0) AS rewording FROM tasks q JOIN projects p ON p.id = q.project_id
    LEFT JOIN tasks root ON root.id = json_extract(q.json, '$.resumeRootId')
    LEFT JOIN tasks asker ON q.kind = 'area_check' AND asker.id = json_extract(q.json, '$.context.checksTaskId')
    WHERE p.deleted_at IS NULL AND q.state = 'queued' AND ${filter}
    AND (p.editing_paused = 0 OR q.kind NOT IN ${PROJECT_EDIT_KINDS})
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
    return saveTask(ctx, { ...task, createdAt, state: "claimed", hostId: host.id, startedAt, workedMs: pausedWork(ctx, task) ?? 0 });
  }
  return null;
}
