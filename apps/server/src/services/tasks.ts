import {
  AgentId,
  dialogueCommand,
  isAsideTask,
  isHandOff,
  isLearningCheck,
  isProjectEditTask,
  isSkillEdit,
  isStyleGuideEdit,
  planText,
  PROJECT_EDIT_TASK_KINDS,
  questionChoicesOf,
  reviewItemPath,
  skillCommands,
  splitAgentTarget,
  taskDialogueOperation,
  TaskPlan,
  type CompleteTaskRequest,
  type Task,
  type TaskEvent,
  type TaskKind,
  type User,
} from "@scarlet/shared";
import { describeDialogueRemovals, dialogueReceipt, dialogueRemovals, newId, type Author, type Change } from "@scarlet/timeline";
import type { Ctx } from "../context.js";
import { now } from "../db.js";
import { badRequest, conflict } from "../errors.js";
import { clip, logId, since } from "../logText.js";
import { recordTaskFinished, recordTaskRequested } from "../telemetry/events.js";
import { taskFailureReason } from "../telemetry/failureReason.js";
import { actorFor, agentName, logActivity, quote } from "./activity.js";
import { applyChoicesWhenDone, applySettledCuts, retireStaleSaves } from "./changes.js";
import { skillEditEnded, startLearningCheck } from "./learnings.js";
import { notify } from "./notify.js";
import { restoreUnreplacedProposal } from "./revisionState.js";
import { runAttemptIds } from "./runAttempts.js";
import { aboutStagedCut, followUpInstruction, RESUMABLE } from "./taskPrompts.js";

/** States a task never leaves. */
export const FINISHED_TASK: ReadonlySet<string> = new Set(["done", "failed", "cancelled"]);

/** Failure categories where a sibling learning_check on the same assistant would only repeat the failure. */
const ASSISTANT_FAILURE_CANCEL_LEARNING: ReadonlySet<string> = new Set([
  "agent_not_installed",
  "agent_not_signed_in",
  "agent_incompatible",
  "rate_limited",
  "model_unavailable",
  "provider_error",
  "crashed",
]);

/** Requests that can edit a project's video. */
export const PROJECT_EDIT_KINDS = `(${PROJECT_EDIT_TASK_KINDS.map(kind => `'${kind}'`).join(",")})`;

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
    /** Words already read for a rule when the editor first sent them: a Retry or Resume of a request isn't read again. */
    wordsRead?: boolean;
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
  if (!input.wordsRead) startLearningCheck(ctx, task);
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
export function pausedWork(ctx: Ctx, task: Task): number | undefined {
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
    next = { ...recordWorkThrough(next, receivedAt), state: "waiting_for_user", question: ev.text, questionChoices: questionChoicesOf(ev.data) };
    notify(ctx, `Agent question: ${ev.text.slice(0, 80)}`, {
      body: ev.text,
      projectId: task.projectId,
      link: reviewItemPath(task.projectId, task.id),
    });
  } else if (ev.type === "answer") {
    const operation = editsDialogue(task.kind) && requestedDialogue(ctx, ev.text);
    next = { ...next, workedMs: pausedWork(ctx, task), state: "queued", hostId: null, question: null, questionChoices: undefined,
      ...(operation && operation !== taskDialogueOperation(task) && { context: { ...task.context, dialogueOperation: operation, dialogueRange: undefined }, repeatAudit: undefined }),
      ...(task.cutConflict && { cutConflict: { ...task.cutConflict, answered: true, retried: undefined } }) };
  } else if (ev.type === "change" && typeof ev.data?.changeId === "string") {
    const id = ev.data.changeId;
    if (!next.changeIds.includes(id)) next = { ...next, changeIds: [...next.changeIds, id] };
  } else if (ev.type === "log" && ev.data?.kind === "init" && typeof ev.data.sessionId === "string" && ev.data.sessionId && RESUMABLE.has(task.agent)) {
    // The CLI session this run works in. A run cut short when Scarlet quits carries on in it.
    if (next.session?.id !== ev.data.sessionId) next = { ...next, session: { agent: task.agent, id: ev.data.sessionId } };
  }
  // The step it takes (running, waiting for the editor, queued again) is logged once, where it is saved. What was asked
  // and what was answered stay out of the log.
  if (next !== task) next = saveTask(ctx, next);
  ctx.bus.publish({ type: "task.event", projectId: task.projectId, taskId: task.id, event });
  if (ev.type === "answer") ctx.bus.taskQueued({ taskId: task.id, projectId: task.projectId });
  return { task: next, event };
}

export function isDialoguePass(task: Task) {
  return editsDialogue(task.kind) && task.context.editIndex === undefined && task.context.cutIndex === undefined &&
    taskDialogueOperation(task) === "first-cut";
}

/**
 * Closing checks an engine before 2026-11-21 left behind. That engine sent a dialogue pass that said it was done back
 * to work, as the same request in a fresh session, while its repeat check still listed findings: about 2M tokens a
 * return on Codex, on the word of finders some of which read only English. The check is now evidence the model reads,
 * and a pass that says it is done is done (`completeTask`), so a stored check has nothing left to run for. One waiting
 * to start, or put back in line by a quit or a pause, finishes as done with the pass's words, as the pass would have
 * finished. One that asked the editor a question waits for the answer, and one holding the answer carries on with it,
 * as any run does. A finished pass whose check couldn't run isn't owed one any more, so the record that offered Retry
 * for it goes; what the check measured stays (2026-11-21).
 */
export function settleClosingChecks(ctx: Ctx): void {
  ctx.db.transaction(() => {
    for (const task of ctx.repos.tasks.select("state = 'queued' AND json_extract(json, '$.repeatAudit.returns') > 0", [], "created_at, rowid")) {
      if (!isDialoguePass(task)) continue;
      const last = ctx.repos.taskEvents.list(task.id, "questionsAndAnswers").at(-1);
      if (last?.type === "answer" && last.at >= (task.startedAt ?? "")) continue;
      completeTask(ctx, task, { state: "done" });
      ctx.db.afterCommit(() => ctx.log(`[task] closing_check_settled task=${logId(task.id)} project=${logId(task.projectId)} outcome=done`));
    }
    for (const task of ctx.repos.tasks.select("state = 'done' AND json_extract(json, '$.repeatAudit.failed') IS NOT NULL", [], "created_at, rowid")) {
      saveTask(ctx, { ...task, repeatAudit: { ...task.repeatAudit!, failed: undefined } });
    }
  }, "immediate")();
}

/** Defer completion when a save hit a cut conflict, or convert to a failure once the answer also failed to finish. */
function resolveCutConflictOnDone(ctx: Ctx, task: Task): { done: Task } | { fail: CompleteTaskRequest } {
  if (task.state === "waiting_for_user") return { done: task };
  if (!task.cutConflict!.retried) {
    const queued = saveTask(ctx, { ...recordWorkThrough(task, now()), state: "queued", hostId: null, session: undefined,
      cutConflict: { ...task.cutConflict!, retried: true } });
    ctx.db.afterCommit(() => ctx.log(`[task] completion_deferred task=${logId(task.id)} project=${logId(task.projectId)} outcome=queued reason=cut_changed`));
    ctx.bus.taskQueued({ taskId: queued.id, projectId: queued.projectId });
    return { done: queued };
  }
  if (task.state === "queued") return { done: task };
  if (!task.cutConflict!.answered) {
    const asked = appendTaskEvent(ctx, task, { type: "question", text: task.cutConflict!.range
      ? "The take here changed. Should I trim the current take or keep it as it plays?"
      : "The takes have changed. Which words should I keep here?" }).task;
    ctx.db.afterCommit(() => ctx.log(`[task] completion_deferred task=${logId(task.id)} project=${logId(task.projectId)} outcome=waiting_for_user reason=cut_changed`));
    return { done: asked };
  }
  return { fail: { state: "failed", error: "Scarlet could not finish the cut using your answer. Your answer is saved." } };
}

/** Build the combined receipt summary when a completed task saved dialogue changes. */
function formatDialogueSummary(changes: Change[]): string {
  // A pass saved in parts reports its removals once.
  const removals = changes.map(dialogueRemovals);
  const combined = removals.filter(Boolean).length > 1 ? describeDialogueRemovals(removals.flatMap(r => r ?? [])) : undefined;
  return changes.flatMap((c, i) => {
    if (combined && removals[i]) return removals.findIndex(Boolean) === i ? [combined] : [];
    const receipt = dialogueReceipt(c);
    if (receipt) return [receipt];
    if (c.state === "approved") return [`Applied “${c.description.replace(/[.!?]$/, "")}”.`];
    if (c.state === "ready") return [`“${c.description.replace(/[.!?]$/, "")}” is pending review.`];
    return [];
  }).join(" ");
}

export function completeTask(ctx: Ctx, task: Task, body: CompleteTaskRequest): Task {
  if (FINISHED_TASK.has(task.state)) {
    throw conflict("task_finished", `task is already ${task.state}`);
  }
  // A host can finish after an unsuccessful save. Keep the actual passage and the editor's answer
  // attached to this request even when the agent ended its turn without asking its own question.
  if (body.state === "done" && task.cutConflict) {
    const resolved = resolveCutConflictOnDone(ctx, task);
    if ("done" in resolved) return resolved.done;
    body = resolved.fail;
  }
  if (task.kind === "skill_from_change" && body.state === "done" && !task.resultSkillId) {
    body = { state: "failed", error: "The requested skill was not saved. Request it again from the approved change." };
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
    // A pass with calls still waiting puts the cuts it settled into the video as it finishes, so the video is the edit as it will be.
    for (const change of own()) applySettledCuts(ctx, change);
    retireStaleSaves(ctx, task);
    // A run resumed after a quit may finish without saving another part. Its earlier attempts' pass still applies.
    const attempts = task.resumeRootId && runAttemptIds(task.projectId, task.resumeRootId);
    if (attempts) for (const change of ctx.repos.changes.select(`project_id = ? AND state = 'ready' AND json_extract(json, '$.taskId') IN (${attempts.sql})`,
        [task.projectId, ...attempts.params])) {
      if (change.taskId !== task.id) applyChoicesWhenDone(ctx, change);
    }
    if (attempts) for (const change of ctx.repos.changes.select(`project_id = ? AND state = 'ready' AND json_extract(json, '$.taskId') IN (${attempts.sql})`,
        [task.projectId, ...attempts.params])) {
      if (change.taskId !== task.id) applySettledCuts(ctx, change);
    }
  }
  // A dialogue pass that says it is done is done, whatever its repeat check still lists. What the check last measured
  // stays on the task as it was recorded (`repeatAudit`: the version, what remained, whether it found nothing, what it
  // couldn't read), for the editor's window and for the evals that count what a pass left. Until 2026-11-21 the engine
  // sent a pass with findings outstanding back to work in a fresh session, up to four times, and failed it after that:
  // each return cost about 2M tokens on Codex, and finders some of which read only English decided it. Whether a listed
  // repeat, silence or divided sentence is cut, kept or staged for the editor, and whether a listed picture is changed or
  // kept, is the model's call, made in its run.
  const changes = body.state === "done" ? own() : [];
  const dialogue = changes.some(c => dialogueReceipt(c));
  const summary = dialogue ? formatDialogueSummary(changes) : body.summary ?? task.summary;
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
  dropWaitingLooks(ctx, saved);
  // If the request failed because the assistant/model itself is broken, unavailable or rate-limited,
  // cancel its sibling learning check instead of letting it fail with the same error.
  if (saved.state === "failed" && ASSISTANT_FAILURE_CANCEL_LEARNING.has(taskFailureReason(saved))) {
    for (const check of openChecks(ctx, saved, "learning_check")) cancelTask(ctx, check);
  }
  const ran = since(saved.startedAt, Date.parse(saved.finishedAt!));
  ctx.db.afterCommit(() => {
    ctx.log(`[task] ${saved.id} ${saved.state}${ran ? ` after ${ran}` : ""}${body.error ? `: ${clip(body.error, 400)}` : ""}` +
      `${changeIds.length ? ` (${changeIds.length} change${changeIds.length === 1 ? "" : "s"})` : ""}` +
      `${needsTranscripts.length ? `, without the transcript of ${needsTranscripts.join(", ")}` : ""}`);
    if (needsTranscripts.length) ctx.log(`[task] completion_deferred task=${logId(task.id)} project=${logId(task.projectId)} outcome=awaiting_transcripts reason=transcripts remaining=${needsTranscripts.length}`);
  });
  const asked = saved.context.message ?? saved.instruction.split("\n").pop() ?? saved.instruction;
  // A hand-off is told the editor's words, but its end is its own, not the request's: it is logged as the kind of work
  // it did and its brief, so the request reads as finished once.
  const handOff = isHandOff(saved);
  const did = handOff ? `${saved.context.handOff?.name ?? "a hand-off"}: ${quote(saved.instruction)}` : quote(asked);
  // A learning check is Scarlet's own reading of a request. What it offers is in Learnings; the run itself is no one's news.
  if (!isLearningCheck(saved)) logActivity(ctx, {
    projectId: isSkillEdit(saved) || isStyleGuideEdit(saved) ? null : saved.projectId,
    actor: { type: "agent", id: saved.agent, name: saved.agent, model: saved.model },
    type: `${handOff ? "hand_off" : "request"}.${body.state}`,
    summary:
      body.state === "done"
        ? `${agentName(saved.agent)} finished ${did}${changeIds.length ? ` and saved ${changeIds.length} edit${changeIds.length === 1 ? "" : "s"}` : ""}`
        : body.state === "failed"
          ? `${agentName(saved.agent)} couldn’t finish ${did}${body.error ? `: ${body.error.slice(0, 160)}` : ""}`
          : `${agentName(saved.agent)} stopped working on ${did}`,
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

/** The side checks of one kind a request started that haven't finished. */
function openChecks(ctx: Ctx, task: Task, kind: "learning_check" | "area_check" | "listen_check" | "hand_off"): Task[] {
  // A hand-off's saves ask for looks at frames as a request's do, in its own name.
  if (!editsDialogue(task.kind) && !isHandOff(task)) return [];
  return ctx.repos.tasks.select("project_id = ? AND kind = ? AND json_extract(json, '$.context.checksTaskId') = ?", [task.projectId, kind, task.id])
    .filter(check => !FINISHED_TASK.has(check.state));
}

/**
 * A request that has ended leaves no look at a frame waiting to start, and no listen or hand-off at all: none would serve it, and a look left waiting
 * would hold back the next request's asks about the same recording. One already looking finishes, since what it finds
 * is kept for the recording.
 */
export function dropWaitingLooks(ctx: Ctx, task: Task): void {
  for (const check of openChecks(ctx, task, "area_check")) if (check.state === "queued") cancelTask(ctx, check);
  // What a listen hears is told only to the run that asked, so one under way stops as well. A hand-off works for the
  // run that handed it the work, which is over.
  for (const check of openChecks(ctx, task, "listen_check")) cancelTask(ctx, check);
  for (const check of openChecks(ctx, task, "hand_off")) cancelTask(ctx, check);
}

/**
 * A look, a listen or a hand-off still waiting to start for a run that is over, or gone, never starts: it is claimed
 * only while that run is at work. Left waiting, a look holds back every later ask about its recording until the ask
 * gives up (a hand-off's looks were left so until 2026-11-24). Run as the engine starts.
 */
export function dropOrphanedChecks(ctx: Ctx): void {
  const orphans = ctx.db.prepare(`SELECT q.id FROM tasks q LEFT JOIN tasks asker ON asker.id = json_extract(q.json, '$.context.checksTaskId')
    WHERE q.state = 'queued' AND q.kind IN ('area_check', 'listen_check', 'hand_off')
    AND (asker.id IS NULL OR asker.state IN ('done', 'failed', 'cancelled'))`).all() as Array<{ id: string }>;
  for (const { id } of orphans) {
    const check = ctx.repos.tasks.get(id);
    if (check) cancelTask(ctx, check);
  }
}

/**
 * `withdrawn`: the editor took the request's words back with ⌘Z, while it waited or ran. Stop this edit is not that:
 * it ends a run, and what the editor said still stands.
 */
export function cancelTask(ctx: Ctx, task: Task, opts: { withdrawn?: boolean } = {}): Task {
  if (FINISHED_TASK.has(task.state)) return task;
  const finishedAt = now();
  const closed = recordWorkThrough(task, finishedAt);
  const saved = saveTask(ctx, { ...closed, workedMs: closed.workedMs ?? pausedWork(ctx, task), state: "cancelled", finishedAt });
  recordTaskFinished(ctx, saved);
  const ran = since(task.startedAt, Date.parse(saved.finishedAt!));
  ctx.log(`[task] ${task.id} cancelled while ${task.state}${ran ? ` after ${ran}` : ""}${opts.withdrawn ? ", withdrawn" : ""}`);
  ctx.db.afterCommit(() => ctx.transcriptions.get(task.id)?.controller.abort());
  skillEditEnded(ctx, saved);
  // Words taken back, as reworded ones are, teach nothing: the check reading them stops, whatever it is doing. That is
  // a request taken back before it started, or one ⌘Z took back while it ran. A request stopped with Stop this edit
  // keeps its check: a rule in what the editor said reaches Learnings whether or not the request finishes.
  if (opts.withdrawn || task.state === "queued") for (const check of openChecks(ctx, task, "learning_check")) cancelTask(ctx, check);
  // The frames a request asked to have looked at serve its own run alone, and that run is over: stopped, taken back or
  // put back in line by a pause, where the attempt that resumes it asks again.
  for (const check of openChecks(ctx, task, "area_check")) cancelTask(ctx, check);
  for (const check of openChecks(ctx, task, "listen_check")) cancelTask(ctx, check);
  for (const check of openChecks(ctx, task, "hand_off")) cancelTask(ctx, check);
  ctx.bus.taskQueued({ taskId: saved.id, projectId: saved.projectId });
  return saved;
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
export function rewordTask(ctx: Ctx, user: User, task: Task, text: string, skillIds?: string[], styleGuideIds?: string[]): Task {
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
  const styleGuides = styleGuideIds?.length ? [...new Set(styleGuideIds)] : undefined;
  const saved = saveTask(ctx, { ...task, instruction, context: { ...task.context, ...message, skillIds: skills, styleGuideIds: styleGuides, asked: undefined,
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
  for (const check of openChecks(ctx, task, "learning_check")) cancelTask(ctx, check);
  startLearningCheck(ctx, saved);
  ctx.bus.taskQueued({ taskId: saved.id, projectId: saved.projectId });
  return saved;
}
