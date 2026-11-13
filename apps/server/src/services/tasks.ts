import { agentCapabilities, isAsideTask, isLearningCheck, isSkillEdit, planText, reviewItemPath, splitAgentTarget, TaskPlan, dialogueCommand, taskDialogueOperation, taskRunKind } from "@scarlet/shared";
import { AgentId, type AgentHost, type CompleteTaskRequest, type Task, type TaskEvent, type TaskKind, type TaskPrompt, type User } from "@scarlet/shared";
import { buildSystemPrompt } from "@scarlet/mcp/prompt";
import { describeDialogueRemovals, dialogueReceipt, dialogueRemovals, newId, type Author } from "@scarlet/timeline";
import type { Ctx } from "../context.js";
import { now } from "../db.js";
import { clip, since } from "../logText.js";
import { badRequest, conflict, notFound } from "../errors.js";
import { recordTaskFinished, recordTaskRequested } from "../telemetry/events.js";
import { notify } from "./notify.js";
import { actorFor, agentName, logActivity, quote } from "./activity.js";
import { restoreUnreplacedProposal } from "./revisionState.js";
import { assistantSkills } from "./skills.js";
import { applyChoicesWhenDone, changeDiff, cutRevisionReference, passToRevise, retireStaleSaves } from "./changes.js";
import { resolveTimeline } from "./timeline.js";
import { learningCheckContext, skillEditEnded, startLearningCheck } from "./learnings.js";

/** States a task never leaves. */
export const FINISHED_TASK: ReadonlySet<string> = new Set(["done", "failed", "cancelled"]);

/** The recording has a saved transcript. */
export function hasTranscript(ctx: Ctx, mediaId: string): boolean {
  return !!ctx.db.prepare("SELECT 1 FROM transcripts WHERE media_id = ? LIMIT 1").get(mediaId);
}

/**
 * Recordings whose transcript or dialogue analysis the run waited for and never got, and whose transcript still
 * isn't saved. The MCP server records each wait and how it ended, so this is measured, not the agent's account.
 */
export function unmetTranscriptWaits(ctx: Ctx, taskId: string): string[] {
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

const editsDialogue = (kind: TaskKind) => kind === "edit" || kind === "revise" || kind === "note";

function requestedDialogue(ctx: Ctx, text: string) {
  if (!dialogueCommand(text)) return;
  return dialogueCommand(text, ctx.repos.skills.select("name IN ('dialogue-pass','first-cut-dialogue','tighten-pauses-here')"));
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
    stagedCutRevision: input.stagedCutRevision ?? (selected && selected.projectId === input.projectId
      ? input.kind === "revise" || selected.intent === "suggestion" && (["ready", "revising"].includes(selected.state) || !!selected.replacedBy) : undefined),
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
  const event = ctx.repos.taskEvents.append({ ...ev, id: ev.id ?? newId("evt"), taskId: task.id, at: ev.at ?? now() });
  if (ev.type === "question" && asksForARule(task)) {
    ctx.bus.publish({ type: "task.event", projectId: task.projectId, taskId: task.id, event });
    return { task: returnRuleWithQuestion(ctx, task, ev.text), event };
  }
  let next: Task = task;
  if (task.state === "claimed") next = { ...next, state: "running", startedAt: next.startedAt ?? now() };
  if (ev.type === "question") {
    next = { ...next, state: "waiting_for_user", question: ev.text };
    notify(ctx, `Agent question: ${ev.text.slice(0, 80)}`, {
      body: ev.text,
      projectId: task.projectId,
      link: reviewItemPath(task.projectId, task.id),
    });
  } else if (ev.type === "answer") {
    const operation = editsDialogue(task.kind) && requestedDialogue(ctx, ev.text);
    next = { ...next, state: "queued", hostId: null, question: null,
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

/** The same pass owns its verification, even when the editor's final call lands after the original run finished. */
export function queueRepeatCheck(ctx: Ctx, task: Task, version: string, changeIds = task.changeIds) {
  const receipt = task.repeatAudit?.version === version ? task.repeatAudit : undefined;
  const queued = saveTask(ctx, { ...task, changeIds, state: "queued", hostId: null, session: undefined, finishedAt: undefined,
    repeatAudit: { ...receipt, version, noFindings: undefined, returns: (receipt?.returns ?? 0) + 1 } });
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
      const queued = saveTask(ctx, { ...task, state: "queued", hostId: null, session: undefined,
        cutConflict: { ...task.cutConflict, retried: true } });
      ctx.bus.taskQueued({ taskId: queued.id, projectId: queued.projectId });
      return queued;
    }
    if (task.state === "queued") return task;
    if (!task.cutConflict.answered) return appendTaskEvent(ctx, task, { type: "question", text: task.cutConflict.range
      ? "The take here changed. Should I trim the current take or keep it as it plays?"
      : "The takes have changed. Which words should I keep here?" }).task;
    body = { state: "failed", error: "Scarlet could not finish the cut using your answer. Your answer is saved." };
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
    retireStaleSaves(ctx, task);
    // A run resumed after a quit may finish without saving another part. Its earlier attempts' pass still applies.
    const rootId = task.resumeRootId;
    if (rootId) for (const change of ctx.repos.changes.select(`project_id = ? AND state = 'ready' AND json_extract(json, '$.taskId') IN
        (SELECT id FROM tasks WHERE id = ? OR json_extract(json, '$.resumeRootId') = ?)`, [task.projectId, rootId, rootId])) {
      if (change.taskId !== task.id) applyChoicesWhenDone(ctx, change);
    }
  }
  // Scheduled editor decisions above can advance playback too. The receipt must name the version that actually plays.
  if (body.state === "done" && task.startedAt && (task.state === "claimed" || task.state === "running") && isDialoguePass(task)) {
    const project = ctx.repos.projects.get(task.projectId);
    if (project?.head && (!task.context.branch || project.branch === task.context.branch) && !unmetTranscriptWaits(ctx, task.id).length) {
      const timeline = resolveTimeline(ctx, project);
      const audible = new Set(project.media.filter(m => m.kind === "audio" || (m.kind === "video" && m.hasAudio !== false)).map(m => m.id));
      const plays = timeline.tracks.some(t => !t.muted && t.clips.some(c => c.kind === "media" && c.enabled && c.volume > 0 && audible.has(c.mediaId)));
      const receipt = task.repeatAudit?.version === project.head ? task.repeatAudit : undefined;
      if (plays && (receipt?.remaining !== 0 || receipt.unavailable?.length || receipt.retakes !== ctx.settings().dialogue.aiCuts.retake)) {
        if (receipt?.unavailable?.length || (receipt?.returns ?? 0) >= 2) {
          body = { ...body, state: "failed", interrupted: true, error: receipt?.unavailable?.join(" ") ||
            "The final audio check still has repeated dialogue to resolve. Resume to finish checking the saved edit." };
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
  const saved = saveTask(ctx, {
    ...task,
    state: body.state,
    summary,
    ...(reply ? { reply } : {}),
    ...(needsTranscripts.length ? { needsTranscripts } : {}),
    error: body.error,
    changeIds,
    question: null,
    finishedAt: now(),
    // The host stopped a stalled run. Its saved work stands, and the editor can resume it.
    ...(body.state === "failed" && body.interrupted ? { interrupted: true } : {}),
  });
  recordTaskFinished(ctx, saved);
  const ran = since(saved.startedAt, Date.parse(saved.finishedAt!));
  ctx.log(`[task] ${saved.id} ${body.state}${ran ? ` after ${ran}` : ""}${body.error ? `: ${clip(body.error, 400)}` : ""}` +
    `${changeIds.length ? ` (${changeIds.length} change${changeIds.length === 1 ? "" : "s"})` : ""}` +
    `${needsTranscripts.length ? `, without the transcript of ${needsTranscripts.join(", ")}` : ""}`);
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
  const saved = saveTask(ctx, { ...task, state: "cancelled", finishedAt: now() });
  recordTaskFinished(ctx, saved);
  const ran = since(task.startedAt, Date.parse(saved.finishedAt!));
  ctx.log(`[task] ${task.id} cancelled while ${task.state}${ran ? ` after ${ran}` : ""}`);
  ctx.db.afterCommit(() => ctx.transcriptions.get(task.id)?.controller.abort());
  skillEditEnded(ctx, saved);
  ctx.bus.taskQueued({ taskId: saved.id, projectId: saved.projectId });
  return saved;
}

/** CLIs whose sessions Scarlet resumes after an answer. Codex runs stay ephemeral, out of the user's Codex thread list. */
export const RESUMABLE = new Set<string>(["claude"]);

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
    workDir: opts.workDir,
    timeLimitMinutes: opts.timeLimitMinutes,
    capabilities: { ...agentCapabilities(task.agent), plan: plans },
  });
  // Whether the host launches the CLI with its own to-do tool on.
  const plan = plans ? { plan: true } : {};
  if (isDialoguePass(task) && task.repeatAudit?.returns) {
    const finish = "The dialogue pass has saved its editing work. Finish only the repeat check on the current playback. " +
      "Use dialogue_check_repeats with the current version, repair accidental repeats with dialogue_apply_cuts, and recheck the resulting audio. " +
      "Keep intentional speech with its reason. Honor the editor’s scope, preferences, protected footage and decisions.";
    return { systemPrompt, instruction: finish + "\nEditor’s request: " + firstMessage(task.instruction.trim()) +
      (answered ? "\nThe editor answered: " + last!.text : ""), ...plan };
  }
  return resumeSession
    ? { systemPrompt, instruction: answered ? `The editor answered: "${last!.text.trim()}"\nContinue the task with that answer.` : INTERRUPTED, resumeSession, ...plan }
    : { systemPrompt, instruction: firstMessage(task.instruction.trim()), ...plan };
}

/**
 * The request as a CLI's first message. Claude Code takes a message that begins with "/" for one of its own slash
 * commands. Finding none of that name, it tells the model the command did not run and to say it isn't installed, and
 * a pass then opened its reply with "The /first-cut-dialogue command isn't installed in this session" (2026-11-07).
 * A lead-in keeps the editor's words as typed and out of the CLI's command parser. The system prompt carries the
 * instruction as well, unchanged.
 */
export function firstMessage(instruction: string) {
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
  return pass?.projectId === projectId ? cutRevisionReference(pass, { cutIndex, time: time!, end: context.end, clipIds: context.clipIds ?? [] }) : "";
}

/** How long a hold for rewording lasts unless the app renews it, so a closed app can't keep a request from ever starting. */
export const REWORDING_HOLD_MS = 90_000;

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

/** Claim the oldest queued task this host can run (or a specific one). Null when none. */
export function claimTask(ctx: Ctx, host: AgentHost, taskId?: string, freeAgents?: string[], desktopPid?: number): Task | null {
  return ctx.db.transaction(() => claimNext(ctx, host, taskId, freeAgents, desktopPid), "immediate")();
}

function claimNext(ctx: Ctx, host: AgentHost, taskId?: string, freeAgents?: string[], desktopPid?: number): Task | null {
  if (taskId) {
    const target = ctx.repos.tasks.get(taskId);
    if (!target) return null;
    if (target.state !== "queued") throw conflict("not_queued", `task is ${target.state}`);
    if (!hostCanRun(host, target)) throw conflict("agent_unavailable", `host has no usable "${target.agent}" agent`);
  }
  const agents = host.agents.filter(a => a.installed && a.loggedIn !== false && (!freeAgents || freeAgents.includes(a.id)));
  if (!taskId && !agents.length) return null;
  const filter = taskId ? "q.id = ?" : "q.kind != 'transcribe' AND q.agent IN (SELECT value FROM json_each(?))";
  // A skill edit and a learning check don't touch the video: neither waits for the project's requests nor holds them up.
  // One request at a time per project, in the order they were asked, so two agents never edit the same video at
  // once. A dialogue pass whose staged cuts still need the editor holds back requests that aren't about it. So does one
  // with a cut sent back, while that revision is queued or running; the version a finished revision replaced holds nothing.
  // queueWait in @scarlet/shared explains the same rule in the app; keep the two in step.
  // A request the editor started anyway (startsBeforeCalls) doesn't wait for a pass's calls; it still takes its turn.
  // A request whose words the editor is changing isn't started until they're saved, and still holds its place.
  // IS, not =: a missing thread or change id must compare false, not NULL, or NOT would let the request through.
  const about = (t: string) => `(coalesce(json_extract(${t}.json, '$.context.threadId'), ${t}.id) IS json_extract(o.json, '$.threadId')
    OR json_extract(${t}.json, '$.context.changeId') IS o.id)`;
  const open = (t: string) => `SELECT 1 FROM changes o JOIN tasks ot ON ot.id = json_extract(o.json, '$.taskId')
    WHERE o.project_id = ${t}.project_id AND json_extract(o.json, '$.intent') = 'suggestion'
      AND (o.state = 'ready' OR (o.state = 'revising' AND EXISTS (SELECT 1 FROM tasks rv WHERE rv.project_id = o.project_id
        AND rv.state IN ('queued','claimed','running','waiting_for_user') AND json_extract(rv.json, '$.context.changeId') = o.id)))
      AND json_array_length(coalesce(json_extract(o.json, '$.cutReasons'), '[]')) > 0
      AND json_extract(ot.json, '$.context.branch') IS json_extract(${t}.json, '$.context.branch')`;
  // A resumed run keeps the place in line of the run it continues: requests asked while that run worked still wait for it.
  // It takes that run's row number as well as its time, so a request asked in the same millisecond as that run doesn't pass it.
  const place = (t: string) => {
    const root = (column: string) => `coalesce((SELECT r.${column} FROM tasks r WHERE r.id = json_extract(${t}.json, '$.resumeRootId')), ${t}.${column})`;
    return `${root("created_at")}, ${root("rowid")}, ${t}.rowid`;
  };
  const rows = ctx.db.prepare(`SELECT q.json FROM tasks q JOIN projects p ON p.id=q.project_id
    WHERE p.deleted_at IS NULL AND q.state = 'queued' AND ${filter}
    AND (json_extract(q.json, '$.rewordingUntil') IS NULL OR json_extract(q.json, '$.rewordingUntil') <= ?)
    AND (q.kind IN ('skill_edit', 'learning_check') OR (NOT EXISTS (SELECT 1 FROM tasks prior
      WHERE prior.project_id = q.project_id AND prior.id != q.id AND prior.kind NOT IN ('transcribe', 'skill_edit', 'learning_check')
        AND (prior.state IN ('claimed','running','waiting_for_user')
          OR (prior.state = 'queued' AND (${place("prior")}) < (${place("q")})
            AND NOT EXISTS (${open("q")} AND ${about("q")} AND NOT ${about("prior")}))))
    AND (json_extract(q.json, '$.startsBeforeCalls') IS 1 OR NOT EXISTS (${open("q")} AND NOT ${about("q")}))))
    ORDER BY ${place("q")}`).iterate(taskId ?? JSON.stringify(agents.map(a => a.id)), now());
  for (const row of rows) {
    const task = ctx.repos.tasks.parse(row.json as string);
    if (!hostCanRun(host, task)) continue;
    const seenAt = now();
    const startedAt = task.startedAt && task.startedAt >= seenAt ? new Date(Date.parse(task.startedAt) + 1).toISOString() : seenAt;
    ctx.db.prepare("UPDATE tasks SET worker_pid = ?, worker_seen_at = ? WHERE id = ?").run(desktopPid, seenAt, task.id);
    const waited = since(task.createdAt, Date.parse(seenAt));
    ctx.log(`[task] ${task.id} claimed by ${host.name} (${host.id})${waited ? ` after ${waited} in the queue` : ""}`);
    return saveTask(ctx, { ...task, state: "claimed", hostId: host.id, startedAt });
  }
  return null;
}
