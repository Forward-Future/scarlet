import { DialogueScanPage, planText, taskNeedsTranscripts, taskPlan, taskRecoveryAction, type RunChoice, type Task } from "@scarlet/shared";
import { mergeRanges, type TimeRange } from "@scarlet/timeline";
import { processIsAlive, type Ctx } from "../context.js";
import { now } from "../db.js";
import { conflict, notFound } from "../errors.js";
import { appendTaskEvent, createTask, hasTranscript, RESUMABLE, returnRulesLeftWithQuestions, saveTask } from "./tasks.js";
import { recordTaskFinished } from "../telemetry/events.js";
import { beginRevision } from "./revisionState.js";
import { skillEditEnded } from "./learnings.js";
import { startTranscription, transcribeForDialogue } from "./ingest.js";
import { getTranscriptionProvider, presetLabel } from "../transcribe/index.js";

/** The change row can be durable even if its id hasn't yet been copied onto the task. */
function savedChanges(ctx: Ctx, tasks: Task[]) {
  return ctx.repos.changes.select(`project_id = ? AND
    (json_extract(json, '$.taskId') IN (SELECT value FROM json_each(?)) OR id IN (SELECT value FROM json_each(?)))`,
    [tasks[0]!.projectId, JSON.stringify(tasks.map(t => t.id)), JSON.stringify(tasks.flatMap(t => t.changeIds))], "created_at, rowid");
}

/** A run that keeps losing its worker stops carrying on by itself after this many attempts, and waits for the editor. */
const LOST_WORKER_ATTEMPTS = 3;

/**
 * Called with the write lock held, after the worker has stopped or surrendered the job. Scarlet stopped, not the
 * run, so the run carries on by itself and neither a quit nor a lost worker costs the editor a pass.
 * `quit`: Scarlet closed or was found closed. Otherwise the worker went missing while Scarlet stayed open, which
 * can repeat, so those are counted.
 */
function reconcileTask(ctx: Ctx, task: Task, unstarted: boolean, quit: boolean): Task {
  const saved = settleTask(ctx, task, unstarted);
  ctx.log(`[task] ${task.id} recovered after its worker stopped: ${task.state} → ${saved.state}${saved.error ? ` (${saved.error})` : ""}`);
  const rootId = task.resumeRootId ?? task.id;
  const again = quit || ctx.repos.tasks.count("project_id = ? AND (id = ? OR json_extract(json, '$.resumeRootId') = ?)",
    [task.projectId, rootId, rootId]) < LOST_WORKER_ATTEMPTS;
  let carriesOn = false;
  // A learning check cut short isn't run again: its request has moved on, and the next message is read anyway.
  if (again && saved.state === "failed" && saved.interrupted && saved.kind !== "transcribe" && saved.kind !== "learning_check") {
    try {
      resumeTask(ctx, saved);
      carriesOn = true;
    } catch (err) {
      ctx.log(`[task] ${task.id} couldn’t resume by itself: ${(err as Error).message}`);
    }
  }
  // A rule the editor approved was being saved by this run. An attempt that carries on is still saving it, so the
  // rule stays with that attempt and the skill's next rule waits for it: a skill's edits run one at a time.
  if (!carriesOn) skillEditEnded(ctx, saved);
  return saved;
}

function settleTask(ctx: Ctx, task: Task, unstarted: boolean): Task {
  const finish = (saved: Partial<Task>) => {
    const finished = saveTask(ctx, { ...task, hostId: null, finishedAt: now(), ...saved });
    recordTaskFinished(ctx, finished);
    return finished;
  };
  if (task.kind === "transcribe") {
    // Older engines could stop between saving the transcript, linking the media and finishing the job.
    // Transcribing takes longer than a millisecond, so a transcript saved in the millisecond the task was created is an earlier run's.
    // The copy that speaker analysis saves with its labels never counts, however new: its words are those of the transcript it labelled.
    // Nor does one whose word alignment the run hadn't finished: it is saved when Whisper ends, and the run starts again to finish it.
    const media = task.context.mediaId && ctx.repos.projects.getMedia(task.context.mediaId);
    if (media && media.projectId === task.projectId) {
      const [transcript] = ctx.repos.transcripts.select("media_id = ? AND project_id = ? AND created_at > ? AND json_extract(json, '$.speakerAnalysis') IS NULL AND json_extract(json, '$.aligning') IS NULL",
        [media.id, media.projectId, task.createdAt ?? now()], "created_at DESC LIMIT 1");
      if (transcript) {
        const lastTranscription = { completedAt: transcript.createdAt, model: transcript.modelLabel ?? presetLabel(transcript.localModel) };
        const updated = ctx.repos.projects.putMedia(media.projectId, { ...media, transcriptId: transcript.id, lastTranscription }, media.status, media.error);
        ctx.bus.publish({ type: "media.updated", projectId: media.projectId, media: updated });
        return finish({ state: "done", summary: `${transcript.segments.length} segments` });
      }
    }
    return finish({ state: "failed", interrupted: true, error: "Transcription was interrupted." });
  }

  const changeIds = savedChanges(ctx, [task]).map(c => c.id);
  if (task.resultSkillId) return finish({ state: "done", changeIds, summary: "The skill was saved before the interruption." });
  const lastEvent = ctx.db.prepare(`SELECT json_extract(json, '$.type') AS type, json_extract(json, '$.text') AS text, at
    FROM task_events WHERE task_id = ? ORDER BY at DESC, rowid DESC LIMIT 1`)
    .get(task.id) as { type: string; text: string; at: string } | undefined;
  if (lastEvent?.type === "question") return saveTask(ctx, { ...task, changeIds, state: "waiting_for_user", question: lastEvent.text, hostId: null });
  // Preserve the answer and task workspace of requests stranded by the old host protocol.
  if ((unstarted && !changeIds.length) || (task.state === "running" && lastEvent?.type === "answer" && lastEvent.at >= (task.startedAt ?? ""))) {
    return saveTask(ctx, { ...task, changeIds, state: "queued", hostId: null, question: null });
  }
  return finish({ state: "failed", interrupted: true, changeIds, error: changeIds.length
    ? "The agent was interrupted after saving changes." : "The editing request was interrupted before a result was saved." });
}

/** `quit`: Scarlet is quitting. Otherwise the run's engine went away while Scarlet stayed open, which counts as a lost worker. */
export function interruptTask(ctx: Ctx, taskId: string, ifStartedAt?: string, quit = true): Task {
  return ctx.db.transaction(() => {
    const task = ctx.repos.tasks.get(taskId);
    if (!task) throw notFound("task");
    if (ifStartedAt && task.startedAt !== ifStartedAt) return task;
    // A question, editor cancellation or completion may already have won the race with shutdown.
    if (task.state !== "claimed" && task.state !== "running") return task;
    const worker = ctx.db.prepare("SELECT worker_pid FROM tasks WHERE id = ?").get(taskId) as { worker_pid: number | null };
    // The host reports this only when it shuts down with the run still going, or for the engine before this one.
    const saved = reconcileTask(ctx, task, task.state === "claimed" && worker.worker_pid !== null, quit);
    ctx.bus.taskQueued({ taskId, projectId: task.projectId });
    return saved;
  }, "immediate")();
}

/** Native workers have a local PID. Standalone hosts confirm individual tasks in their 30 s heartbeat. */
export function recoverTasks(ctx: Ctx, starting = false): void {
  const cutoff = new Date(Date.now() - 90_000).toISOString();
  ctx.db.transaction(() => {
    const renew = ctx.db.prepare("UPDATE tasks SET worker_seen_at = ? WHERE id = ?");
    for (const id of ctx.transcriptions.keys()) renew.run(now(), id);
    const workers = ctx.db.prepare(`SELECT id, worker_pid, worker_seen_at FROM tasks WHERE
      (state IN ('claimed','running') OR (kind = 'transcribe' AND state = 'queued'))
      AND (worker_pid IS NOT NULL OR worker_seen_at IS NULL OR worker_seen_at <= ?)`)
      .all(cutoff) as Array<{ id: string; worker_pid: number | null; worker_seen_at: string | null }>;
    for (const { id, worker_pid: pid, worker_seen_at: seen } of workers) {
      const alive = pid !== null && processIsAlive(pid);
      if (starting && (alive || (pid === null && seen))) {
        // A surviving worker gets a heartbeat window after restart or system sleep.
        // Even a reused PID will expire if no worker actually confirms this job.
        renew.run(now(), id);
        continue;
      }
      if (alive && seen && seen > cutoff) continue;
      const task = ctx.repos.tasks.get(id)!;
      // Found dead at startup: Scarlet was closed or crashed mid-run.
      reconcileTask(ctx, task, pid !== null && !alive && task.state === "claimed", starting);
      ctx.bus.taskQueued({ taskId: id, projectId: task.projectId });
    }
    if (starting) returnRulesLeftWithQuestions(ctx);
  }, "immediate")();
  resumeTranscriptions(ctx);
}

/**
 * A transcription runs inside the engine, so quitting Scarlet stops it. Continue from its last committed audio chunk or alignment turn
 * when the engine is back, or when the project's media processing resumes. Only an interruption restarts:
 * a transcription that failed by itself waits for the editor.
 */
function resumeTranscriptions(ctx: Ctx): void {
  const interrupted = ctx.repos.tasks.select(`kind = 'transcribe' AND state = 'failed' AND json_extract(json, '$.interrupted') = 1
    AND NOT EXISTS (SELECT 1 FROM tasks later WHERE later.kind = 'transcribe' AND later.project_id = tasks.project_id
      AND json_extract(later.json, '$.context.mediaId') = json_extract(tasks.json, '$.context.mediaId')
      AND (later.created_at, later.rowid) > (tasks.created_at, tasks.rowid))`, [], "created_at, rowid");
  for (const task of interrupted) {
    try {
      const media = task.context.mediaId && ctx.repos.projects.getMedia(task.context.mediaId);
      const header = task.projectId ? ctx.repos.projects.header(task.projectId) : undefined;
      if (!media || media.projectId !== task.projectId || media.status !== "ready" || !header) continue;
      // An archived project is put away. Its cut-off transcriptions wait until a launch after it is taken out again.
      if (media.kind === "image" || media.hasAudio === false || header.mediaPaused || header.archived) continue;
      // The interrupted run may have been a second transcript the editor asked for, with a provider chosen for it.
      // It starts again as it was asked, unless its transcript was saved just before the interruption. A transcript the
      // recording already had doesn't count, even one saved in the millisecond the run was created, and neither does the
      // copy of it that speaker analysis saved with its labels while the run worked.
      const chosen = task.context.transcriptionProvider;
      const provider = getTranscriptionProvider(ctx, chosen);
      if (!provider) continue;
      // A cloud service is sent the recording. A cut-off run starts again with one only when that is the service it ran
      // with, so a recording transcribed on this computer isn't uploaded because the setting changed since. A run saved
      // before the service was recorded starts again as it always did.
      const ranWith = task.context.transcribedWith;
      if (provider.name !== "whispercpp" && ranWith && ranWith !== provider.name) {
        ctx.log(`[task] ${task.id} was interrupted; ${media.id} ran with ${ranWith} and is left for Retry, since ${provider.name} is selected now`);
        continue;
      }
      if (ctx.db.prepare(`SELECT 1 FROM transcripts WHERE media_id = ? AND project_id = ? AND created_at > ?
        AND json_extract(json, '$.speakerAnalysis') IS NULL AND json_extract(json, '$.aligning') IS NULL LIMIT 1`)
        .get(media.id, task.projectId, task.createdAt ?? "")) continue;
      const { task: restarted, done } = startTranscription(ctx, task.projectId, media, chosen, "interrupt", { interrupted: task });
      ctx.track(done.catch(() => null));
      ctx.log(`[task] ${task.id} was interrupted; continuing transcription of ${media.id} as ${restarted.id}`);
    } catch (err) {
      ctx.log(`[task] ${task.id} couldn’t restart its transcription: ${(err as Error).message}`);
    }
  }
}

function recoveryInstruction(ctx: Ctx, task: Task, rootId?: string): string {
  const attempts = rootId ? ctx.repos.tasks.select("project_id = ? AND (id = ? OR json_extract(json, '$.resumeRootId') = ?)",
    [task.projectId, rootId, rootId], "created_at, rowid") : [task];
  const events = attempts.flatMap(t => ctx.repos.taskEvents.list(t.id, rootId ? "conversation" : "questionsAndAnswers"));
  const lines = [attempts[0]!.instruction];
  for (const ev of events) {
    if (ev.type === "question") lines.push(`Agent asked: ${ev.text}`);
    if (ev.type === "answer") lines.push(`Editor answered: ${ev.text}`);
  }
  if (!rootId) return lines.join("\n");
  lines.push("", "Resume this interrupted request. Continue only the unfinished work: the saved changes below and their states say what is done. Keep saved proposals and honor the editor’s decisions, including rejected or partially approved edits.");
  if (task.needsTranscripts?.length) {
    const ready = task.needsTranscripts.filter(id => hasTranscript(ctx, id));
    lines.push(`The previous attempt ended without the transcript of ${task.needsTranscripts.join(", ")}.${ready.length ? ` Ready now: ${ready.join(", ")}.` : ""}`);
  }
  const progress: string[] = [];
  const scans = new Map<string, TimeRange[]>();
  for (const ev of events.filter(e => e.type === "log" && e.data?.kind !== "tool_refused")) {
    if (ev.data?.scanPage) {
      const page = DialogueScanPage.safeParse(ev.data.scanPage);
      if (page.success && page.data.to !== undefined) {
        const { mediaId, from, to } = page.data;
        const ranges = scans.get(mediaId) ?? [];
        ranges.push({ start: from, end: to });
        scans.set(mediaId, ranges);
      }
    } else {
      progress.push(ev.text);
    }
  }
  for (const text of progress.slice(-8)) lines.push(`Previous progress: ${text}`);
  const plan = taskPlan(ctx.repos.taskEvents.list(task.id, "lastPlanOrAnswer"));
  if (plan) lines.push("Your plan when it stopped:", planText(plan));
  for (const [mediaId, ranges] of scans) {
    lines.push(`Scanned source seconds on ${mediaId}: ${mergeRanges(ranges).map(r => `${r.start}–${r.end}`).join(", ")}`);
  }
  for (const c of savedChanges(ctx, attempts)) {
    // Scarlet closes a proposal when a later part or a revision takes its cuts over. The editor didn't turn it down:
    // a resumed pass that read fifteen such proposals as [rejected] kept 24 of the 27 cuts held for review, "as you
    // chose earlier" (2026-11-13).
    const state = c.state === "rejected" && c.replacedBy ? `replaced by ${c.replacedBy}, which holds its cuts now; the editor made no decision on it` : c.state;
    lines.push(`Saved change ${c.id} [${state}], version ${c.appliedVersion ?? c.toVersion}: ${c.description}`);
  }
  return lines.join("\n");
}

/**
 * Retry or resume a run. The editor's Retry and Resume send the model picked now, which runs the next attempt, so a
 * run on a model that stopped working can go again on another. Scarlet's own resumes keep the run's model.
 */
export function retryTask(ctx: Ctx, id: string, choice: RunChoice = {}): Task {
  return ctx.db.transaction(() => {
    const task = ctx.repos.tasks.get(id);
    if (!task) throw notFound("task");
    return resumeTask(ctx, task, choice);
  }, "immediate")();
}

/** Called with the write lock held. */
function resumeTask(ctx: Ctx, task: Task, choice: RunChoice = {}): Task {
  const id = task.id;
  if (task.retryTaskId) return ctx.repos.tasks.get(task.retryTaskId)!;
  const action = taskRecoveryAction(task, savedChanges(ctx, [task]).length > 0);
  if (!action) throw conflict("not_retryable", "This request cannot be retried.");
  const resumeRootId = action === "resume" ? task.resumeRootId ?? id : undefined;
  // A new id fences off late events, proposals and completions from the previous worker.
  const run = choice.agent ? { agent: choice.agent, model: choice.model, effort: choice.effort, fast: choice.fast, serviceTier: choice.serviceTier } : {};
  const retry = createTask(ctx, {
    ...task, ...run, state: "queued", instruction: recoveryInstruction(ctx, task, resumeRootId), resumeRootId,
    context: { ...task.context, threadId: task.context.threadId ?? id, message: task.context.message ?? task.instruction },
  });
  const proposal = task.kind === "revise" && task.context.changeId && ctx.repos.changes.get(task.context.changeId);
  // The revision begins again on the proposal it names while that one stands. A pass a later revision has replaced stays
  // put away: marked as revising it would read as the pass this request revises, and its cut would be moved there
  // instead of in the pass that waits now (passToRevise).
  if (proposal && proposal.projectId === task.projectId && proposal.state !== "approved" && proposal.state !== "revising" && !proposal.replacedBy) {
    const change = ctx.repos.changes.put({ ...beginRevision(proposal, retry), updatedAt: now() });
    ctx.bus.publish({ type: "change.updated", projectId: change.projectId, change });
  }
  saveTask(ctx, { ...task, retryTaskId: retry.id });
  ctx.log(`[task] ${id} ${action === "resume" ? "resumed" : "retried"} as ${retry.id}`);
  // A run its host cut short kept its CLI session, so the next attempt on the same model carries on in it instead of
  // starting cold. On another model it starts a session of its own.
  const sameModel = retry.agent === task.agent && retry.model === task.model;
  if (action === "resume" && task.interrupted && task.session && RESUMABLE.has(task.agent) && sameModel) {
    const resumed = saveTask(ctx, { ...retry, session: task.session });
    // The session still holds the plan it was working to, and reports it again only when a step changes. Until then
    // the plan stands as it was left, so the editor sees it where it stopped (2026-11-09: a plan of four steps was
    // gone after a restart while the run carried on).
    const steps = taskPlan(ctx.repos.taskEvents.list(id, "lastPlanOrAnswer"));
    if (steps) appendTaskEvent(ctx, resumed, { type: "plan", text: planText(steps), data: { steps } });
    return resumed;
  }
  return retry;
}

const ACTIVE_TRANSCRIPTION = "kind = 'transcribe' AND state IN ('queued','claimed','running') AND json_extract(json, '$.context.mediaId') = ?";

/**
 * The editor asked to finish a run that ended without its transcripts once they're ready, or stopped waiting.
 * Transcripts that aren't being made yet start now. A run whose transcripts are already ready resumes at once.
 */
export function continueWhenReady(ctx: Ctx, id: string, on: boolean): { task: Task; resumed?: Task } {
  const before = ctx.repos.tasks.get(id);
  if (!before) throw notFound("task");
  if (on && taskNeedsTranscripts(before)) {
    // Starting a transcription takes its own write lock.
    for (const mediaId of before.needsTranscripts!) {
      if (hasTranscript(ctx, mediaId) || ctx.repos.tasks.select(`project_id = ? AND ${ACTIVE_TRANSCRIPTION}`, [before.projectId, mediaId]).length) continue;
      const media = ctx.repos.projects.getMedia(mediaId);
      if (!media || media.projectId !== before.projectId || !transcribeForDialogue(ctx, before.projectId, media)) {
        throw conflict("transcription_unavailable", `Scarlet can’t transcribe ${media?.name ?? mediaId} now. Check Transcription in Settings, and that caching isn’t paused.`);
      }
    }
  }
  const task = ctx.db.transaction(() => {
    const task = ctx.repos.tasks.get(id)!;
    if (task.retryTaskId) return task;
    if (!taskNeedsTranscripts(task)) throw conflict("not_waiting", "This edit isn’t waiting for a transcript.");
    if (!!task.continueWhenReady === on) return task;
    ctx.log(`[task] ${id} ${on ? "will resume when its transcripts are ready" : "no longer waits for its transcripts"}`);
    return saveTask(ctx, { ...task, continueWhenReady: on || undefined });
  }, "immediate")();
  if (task.retryTaskId) return { task, resumed: ctx.repos.tasks.get(task.retryTaskId) ?? undefined };
  const resumed = on ? continueReadyRuns(ctx, task.projectId).find(r => r.resumeRootId === (task.resumeRootId ?? task.id)) : undefined;
  return { task: ctx.repos.tasks.get(id)!, ...(resumed && { resumed }) };
}

/**
 * Resume each run the editor asked to finish once its transcripts are ready. A run whose transcript stopped
 * without being saved stops waiting, so the editor can ask again or carry on.
 */
export function continueReadyRuns(ctx: Ctx, projectId?: string): Task[] {
  const armed = ctx.repos.tasks.select(`state = 'done' AND json_extract(json, '$.continueWhenReady') = 1 AND json_extract(json, '$.retryTaskId') IS NULL${projectId ? " AND project_id = ?" : ""}`,
    projectId ? [projectId] : [], "created_at, rowid");
  const check = ctx.db.transaction((id: string) => {
    // Another engine can finish the request or receive Don't wait after this sweep listed it.
    const task = ctx.repos.tasks.get(id);
    if (!task?.continueWhenReady || !taskNeedsTranscripts(task)) return;
    const pending = task.needsTranscripts!.filter(id => !hasTranscript(ctx, id));
    if (!pending.length) return resumeTask(ctx, task);
    // A transcription cut short by a quit or a pause starts again when Scarlet or the project's media is back, so the run keeps waiting for it.
    const restarts = (id: string) => {
      const [last] = ctx.repos.tasks.select("project_id = ? AND kind = 'transcribe' AND json_extract(json, '$.context.mediaId') = ?",
        [task.projectId, id], "created_at DESC, rowid DESC LIMIT 1");
      return last?.state === "failed" && !!last.interrupted;
    };
    const stopped = pending.filter(id => !restarts(id) && !ctx.repos.tasks.count(`project_id = ? AND ${ACTIVE_TRANSCRIPTION}`, [task.projectId, id]));
    if (stopped.length) {
      ctx.log(`[task] ${task.id} stopped waiting: the transcript of ${stopped.join(", ")} ended without being saved`);
      saveTask(ctx, { ...task, continueWhenReady: undefined });
    }
  }, "immediate");
  const resumed: Task[] = [];
  for (const { id } of armed) {
    try {
      const retry = check(id);
      if (retry) resumed.push(retry);
    } catch (err) {
      ctx.log(`[task] ${id} couldn’t check its transcripts: ${(err as Error).message}`);
    }
  }
  return resumed;
}

/** A transcription that finishes may complete what a run is waiting for. The 30 s recovery sweep catches the rest. */
export function wireContinueWhenReady(ctx: Ctx) {
  ctx.bus.on("ws", event => {
    if (event.type !== "task.updated" || event.task.kind !== "transcribe" || !FINISHED.has(event.task.state)) return;
    try {
      continueReadyRuns(ctx, event.projectId);
    } catch (err) {
      ctx.log(`[task] couldn’t check runs waiting for transcripts: ${(err as Error).message}`);
    }
  });
}

const FINISHED: ReadonlySet<string> = new Set(["done", "failed", "cancelled"]);
