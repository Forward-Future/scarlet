import { toolAnnotations } from "@scarlet/mcp/annotations";
import { beginRevision, closingCheckFailed, DialogueScanPage, planText, taskNeedsTranscripts, taskPlan, taskRecoveryAction, type RunChoice, type Task } from "@scarlet/shared";
import os from "node:os";
import { mergeRanges, type Change, type TimeRange } from "@scarlet/timeline";
import { processIsAlive, type Ctx } from "../context.js";
import { now } from "../db.js";
import { conflict, notFound } from "../errors.js";
import { logId } from "../logText.js";
import { appendTaskEvent, cancelTask, createTask, dropWaitingLooks, FINISHED_TASK, hasTranscript, isDialoguePass, PROJECT_EDIT_KINDS, queueRepeatCheck, recordWorkThrough, RESUMABLE, returnRulesLeftWithQuestions, saveTask } from "./tasks.js";
import { recordTaskFinished } from "../telemetry/events.js";
import { prepareCutReview } from "./changes.js";
import { skillEditEnded, startLearningCheck } from "./learnings.js";
import { latestTranscription, startTranscription, transcribeForDialogue } from "./ingest.js";
import { getTranscriptionProvider, presetLabel } from "../transcribe/index.js";
import { runAttempts, runRoot } from "./runAttempts.js";

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
function reconcileTask(ctx: Ctx, task: Task, unstarted: boolean, quit: boolean, lastSeen?: string | null): Task {
  let saved = settleTask(ctx, task, unstarted, lastSeen);
  if (FINISHED_TASK.has(saved.state)) dropWaitingLooks(ctx, saved);
  const attempts = runAttempts(task.projectId, runRoot(task));
  // Only the attempts that lost their worker count. A pass that came through three quits, or that the editor resumed
  // by hand, still carries on by itself the first time its worker goes missing.
  if (!quit && saved.state === "failed" && saved.interrupted) saved = saveTask(ctx, { ...saved, lostWorker: true });
  const lost = quit ? 0 : ctx.repos.tasks.count(`${attempts.where} AND json_extract(json, '$.lostWorker') = 1`, attempts.params);
  const again = quit || lost < LOST_WORKER_ATTEMPTS;
  let carriesOn = false;
  // A learning check cut short isn't run again: its request has moved on, and the next message is read anyway.
  if (again && saved.state === "failed" && saved.interrupted && saved.kind !== "transcribe" && saved.kind !== "learning_check" && saved.kind !== "area_check") {
    try {
      // All of the next attempt or none of it: one left half made would run beside a run that still offers Resume.
      ctx.db.savepoint(() => resumeTask(ctx, saved, {}));
      carriesOn = true;
    } catch (err) {
      ctx.log(`[task] ${task.id} couldn’t resume by itself: ${(err as Error).message}`);
    }
  }
  // A learning check reads one message and edits nothing, so one cut short by a quit starts again as it first did,
  // unless it had already offered its rule. Otherwise a rule said just before quitting would never reach Learnings.
  // One that lost its worker isn't: the next message is read anyway.
  if (quit && saved.kind === "learning_check" && saved.state === "failed" && saved.interrupted && !saved.retryTaskId) {
    const asked = saved.context.checksTaskId ? ctx.repos.tasks.get(saved.context.checksTaskId) : null;
    if (asked && asked.projectId === saved.projectId
      && !ctx.repos.learnings.count("project_id = ? AND json_extract(json, '$.taskId') = ?", [asked.projectId, asked.id])) {
      const again = startLearningCheck(ctx, asked);
      if (again) saved = saveTask(ctx, { ...saved, retryTaskId: again.id });
    }
  }
  // A rule the editor approved was being saved by this run. An attempt that carries on is still saving it, so the
  // rule stays with that attempt and the skill's next rule waits for it: a skill's edits run one at a time.
  if (!carriesOn) skillEditEnded(ctx, saved);
  const outcome = carriesOn ? "resumed" : saved.retryTaskId ? "retried" : !again ? "retry_limit" : saved.state;
  ctx.db.afterCommit(() => ctx.log(`[task] recovery task=${logId(task.id)} project=${logId(task.projectId)} ` +
    `state=${saved.state} outcome=${outcome} reason=${quit ? "engine_stopped" : "worker_lost"} attempts=${lost}`));
  return saved;
}

/** Retire the workers' attempts and leave their requests at the front of the project's held queue. */
export function holdProjectEditing(ctx: Ctx, projectId: string) {
  return ctx.db.transaction(() => ctx.bus.asSaved(() => {
    const previous = ctx.repos.projects.header(projectId);
    if (!previous) throw notFound("project");
    ctx.repos.projects.setEditingPaused(projectId, true);
    const project = ctx.repos.projects.get(projectId)!;
    if (!previous.editingPaused) ctx.bus.publish({ type: "project.updated", projectId, project });

    // Only a run at work is retired. One waiting on the editor's answer, or back in line after it, holds no worker:
    // it keeps its question, its answer and its CLI session, and the paused queue keeps it from starting.
    const active = ctx.repos.tasks.select(`project_id = ? AND kind IN ${PROJECT_EDIT_KINDS} AND state IN ('claimed','running')`,
      [projectId], "created_at, rowid");
    const tasks = active.flatMap(task => {
      const next = resumeTask(ctx, task, { afterProjectStop: true });
      return [ctx.repos.tasks.get(task.id)!, next];
    });
    return { project, tasks };
  }), "immediate")();
}

/** Release the queue under the same lock as claims. */
export function resumeProjectEditing(ctx: Ctx, projectId: string) {
  return ctx.db.transaction(() => {
    const previous = ctx.repos.projects.header(projectId);
    if (!previous) throw notFound("project");
    ctx.repos.projects.setEditingPaused(projectId, false);
    const project = ctx.repos.projects.get(projectId)!;
    if (!previous.editingPaused) return { project, tasks: [] };
    ctx.bus.publish({ type: "project.updated", projectId, project });
    const waiting = ctx.repos.tasks.select(`project_id = ? AND state = 'queued' AND kind IN ${PROJECT_EDIT_KINDS}`, [projectId]);
    // The editor may have made decisions while editing was stopped. Each attempt put back in line is told where its run
    // stands as it starts (`taskPrompt`), so it reads them.
    const tasks = waiting.filter(task => task.resumesAfterProjectStop && !task.startedAt);
    if (waiting[0]) ctx.bus.taskQueued({ taskId: waiting[0].id, projectId });
    return { project, tasks };
  }, "immediate")();
}

function settleTask(ctx: Ctx, task: Task, unstarted: boolean, lastSeen?: string | null): Task {
  const finishedAt = now();
  const finish = (saved: Partial<Task>) => {
    const finished = saveTask(ctx, { ...task, hostId: null, finishedAt, ...saved });
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
  const lastEvent = ctx.db.prepare(`SELECT json_extract(json, '$.type') AS type, json_extract(json, '$.text') AS text, at
    FROM task_events WHERE task_id = ? ORDER BY at DESC, rowid DESC LIMIT 1`)
    .get(task.id) as { type: string; text: string; at: string } | undefined;
  // An interrupt reported by a live worker stops now. A lost worker is measured through its latest activity.
  const observed = [task.startedAt, lastSeen, lastEvent?.at].filter((at): at is string => !!at && at <= finishedAt).sort().at(-1);
  const { workedMs } = recordWorkThrough(task, lastSeen === undefined ? finishedAt : observed ?? finishedAt);
  if (task.resultSkillId) return finish({ state: "done", changeIds, workedMs, summary: "The skill was saved before the interruption." });
  if (lastEvent?.type === "question") return saveTask(ctx, { ...recordWorkThrough(task, lastEvent.at),
    changeIds, state: "waiting_for_user", question: lastEvent.text, hostId: null });
  // Preserve the answer and task workspace of requests stranded by the old host protocol.
  const pendingAnswer = task.state === "running" && lastEvent?.type === "answer" && lastEvent.at >= (task.startedAt ?? "");
  if ((unstarted && !changeIds.length) || pendingAnswer) {
    return saveTask(ctx, { ...task, workedMs: pendingAnswer ? task.workedMs : workedMs, changeIds, state: "queued", hostId: null, question: null });
  }
  return finish({ state: "failed", interrupted: true, changeIds, workedMs, error: changeIds.length
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
  // A minute's margin for a clock set since.
  const booted = new Date(Date.now() - os.uptime() * 1000 - 60_000).toISOString();
  ctx.db.transaction(() => {
    const renew = ctx.db.prepare("UPDATE tasks SET worker_seen_at = ? WHERE id = ?");
    for (const id of ctx.transcriptions.keys()) renew.run(now(), id);
    const workers = ctx.db.prepare(`SELECT id, worker_pid, worker_seen_at FROM tasks WHERE
      (state IN ('claimed','running') OR (kind = 'transcribe' AND state = 'queued'))
      AND (worker_pid IS NOT NULL OR worker_seen_at IS NULL OR worker_seen_at <= ?)`)
      .all(cutoff) as Array<{ id: string; worker_pid: number | null; worker_seen_at: string | null }>;
    for (const { id, worker_pid: pid, worker_seen_at: seen } of workers) {
      // A worker last heard from before the computer started can't be the process that has its id now.
      const alive = pid !== null && processIsAlive(pid) && !(seen && seen < booted);
      if (starting && (alive || (pid === null && seen))) {
        // A surviving worker gets a heartbeat window after restart or system sleep.
        // Even a reused PID will expire if no worker actually confirms this job.
        renew.run(now(), id);
        continue;
      }
      if (alive && seen && seen > cutoff) continue;
      // Each run is settled by itself: one that can't be leaves the others their recovery, and is tried again in
      // the next round.
      try {
        ctx.db.savepoint(() => {
          const task = ctx.repos.tasks.get(id)!;
          // Found dead at startup: Scarlet was closed or crashed mid-run.
          reconcileTask(ctx, task, pid !== null && !alive && task.state === "claimed", starting, seen);
          ctx.bus.taskQueued({ taskId: id, projectId: task.projectId });
        });
      } catch (err) {
        ctx.log(`[task] ${id} couldn’t be recovered and will be tried again: ${(err as Error).message}`);
      }
    }
    if (starting) {
      try {
        ctx.db.savepoint(() => returnRulesLeftWithQuestions(ctx));
      } catch (err) {
        ctx.log(`[task] couldn’t return the rules left with questions: ${(err as Error).message}`);
      }
    }
  }, "immediate")();
  try {
    resumeTranscriptions(ctx);
  } catch (err) {
    ctx.log(`[task] couldn’t continue interrupted transcriptions: ${(err as Error).message}`);
  }
}

/** A worker still stopping keeps its claim until cleanup. Check its transcription again then. */
export function resumeProjectTranscriptions(ctx: Ctx, projectId: string): void {
  const running = ctx.repos.tasks.select("project_id = ? AND kind = 'transcribe' AND state = 'running'", [projectId]);
  for (const task of running) {
    const worker = ctx.transcriptions.get(task.id);
    const mediaId = task.context.mediaId;
    if (!worker?.controller.signal.aborted || !mediaId) continue;
    void ctx.track(worker.done.catch(() => {
      if (!ctx.shutdown.aborted) resumeTranscriptions(ctx, projectId, mediaId);
    }).catch(err => {
      ctx.log(`[task] ${task.id} couldn’t check whether its transcription should start again: ${(err as Error).message}`);
    }), projectId);
  }
  resumeTranscriptions(ctx, projectId);
}

/**
 * A transcription runs inside the engine, so quitting Scarlet stops it. Continue from its last committed audio chunk or alignment turn
 * when the engine is back, or when the project's media processing resumes. Only an interruption restarts:
 * a transcription that failed by itself waits for the editor.
 */
function resumeTranscriptions(ctx: Ctx, projectId?: string, mediaId?: string): void {
  const interrupted = ctx.repos.tasks.select(`kind = 'transcribe' AND state = 'failed' AND json_extract(json, '$.interrupted') = 1
    AND (? IS NULL OR project_id = ?) AND (? IS NULL OR json_extract(json, '$.context.mediaId') = ?)
    AND NOT EXISTS (SELECT 1 FROM tasks later WHERE later.kind = 'transcribe' AND later.project_id = tasks.project_id
      AND json_extract(later.json, '$.context.mediaId') = json_extract(tasks.json, '$.context.mediaId')
      AND (later.created_at, later.rowid) > (tasks.created_at, tasks.rowid))`, [projectId ?? null, projectId ?? null, mediaId ?? null, mediaId ?? null], "created_at, rowid");
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
        // It won't start again by itself, so it is no longer an interruption: a run that waits for this transcript
        // stops waiting (continueReadyRuns), and this is said once, not every half minute.
        ctx.db.transaction(() => saveTask(ctx, { ...task, interrupted: undefined }), "immediate")();
        continue;
      }
      if (ctx.db.prepare(`SELECT 1 FROM transcripts WHERE media_id = ? AND project_id = ? AND created_at > ?
        AND json_extract(json, '$.speakerAnalysis') IS NULL AND json_extract(json, '$.aligning') IS NULL LIMIT 1`)
        .get(media.id, task.projectId, task.createdAt ?? "")) continue;
      const { task: restarted, done } = startTranscription(ctx, task.projectId, media, chosen, "interrupt", { interrupted: task });
      ctx.track(done.catch(() => null), task.projectId);
      ctx.log(`[task] ${task.id} was interrupted; continuing transcription of ${media.id} as ${restarted.id}`);
    } catch (err) {
      ctx.log(`[task] ${task.id} couldn’t restart its transcription: ${(err as Error).message}`);
    }
  }
}

/**
 * How many of a waiting pass's staged cuts have no recommendation yet. The run that staged them knew, and the one that
 * carries on is a new process that doesn't: without this it can finish with them unchecked, and they reach the
 * editor as calls Scarlet never looked at.
 */
function unchecked(ctx: Ctx, change: Change): string {
  if (change.state !== "ready") return "";
  try {
    const total = prepareCutReview(ctx, change).review?.cuts.length ?? 0;
    const left = total - (change.cutAssessments?.filter(a => !a.provisional).length ?? 0);
    return left > 0 ? ` ${left} of its ${total} staged cuts ${left === 1 ? "has" : "have"} no recommendation yet.` : "";
  } catch {
    return "";
  }
}

/** The edits an attempt tried to save after its last saved change and Scarlet refused, newest last, each said once. */
function refusedSinceLastSave(ctx: Ctx, attempt: Task): string[] {
  const events = ctx.repos.taskEvents.list(attempt.id);
  const lastSave = events.findLastIndex(e => e.type === "change");
  const said = new Set<string>();
  for (const ev of events.slice(lastSave + 1)) {
    const tool = typeof ev.data?.tool === "string" ? ev.data.tool.replace(/^scarlet\./, "") : "";
    if (ev.type !== "log" || ev.data?.kind !== "tool_refused" || !tool || toolAnnotations(tool).readOnlyHint) continue;
    const reason = ev.text.replace(/^Error:\s*/, "").replace(/\s+/g, " ").trim();
    said.delete(`${tool}: ${reason.slice(0, 400)}`);
    said.add(`${tool}: ${reason.slice(0, 400)}`);
  }
  return [...said].slice(-3);
}

/**
 * What an attempt that resumes or retries `task` is told of the run so far. `current`: the attempt being told, when it
 * already exists, which isn't part of what came before it.
 */
export function recoveryInstruction(ctx: Ctx, task: Task, rootId?: string, current?: string): string {
  const run = rootId && runAttempts(task.projectId, rootId);
  const attempts = run ? ctx.repos.tasks.select(run.where, run.params, "created_at, rowid").filter(t => t.id !== current) : [task];
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
  // A line said again and again in a row would fill the window and push out what came before it.
  for (const text of progress.filter((t, i) => t !== progress[i - 1]).slice(-8)) lines.push(`Previous progress: ${text}`);
  const plan = taskPlan(ctx.repos.taskEvents.list(task.id, "lastPlanOrAnswer"));
  if (plan) lines.push("Your plan when it stopped:", planText(plan));
  for (const [mediaId, ranges] of scans) {
    lines.push(`Scanned source seconds on ${mediaId}: ${mergeRanges(ranges).map(r => `${r.start}–${r.end}`).join(", ")}`);
  }
  const unsaved = refusedSinceLastSave(ctx, attempts.at(-1)!);
  if (unsaved.length) {
    // A restart that lands just after a refused save leaves that work undone, and nothing in the saved changes says so
    // (2026-11-18: the framing of a demo's last four minutes was refused, then the app restarted to update).
    lines.push("Not saved when it stopped (Scarlet refused these after its last saved change, so that work is still to do):");
    for (const text of unsaved) lines.push(`- ${text}`);
  }
  for (const c of savedChanges(ctx, attempts)) {
    // Scarlet closes a proposal when a later part or a revision takes its cuts over. The editor didn't turn it down:
    // a resumed pass that read fifteen such proposals as [rejected] kept 24 of the 27 cuts held for review, "as you
    // chose earlier" (2026-11-13).
    const state = c.state === "rejected" && c.replacedBy ? `replaced by ${c.replacedBy}, which holds its cuts now; the editor made no decision on it` : c.state;
    lines.push(`Saved change ${c.id} [${state}], version ${c.appliedVersion ?? c.toVersion}: ${c.description}${unchecked(ctx, c)}`);
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
    return resumeTask(ctx, task, { choice, byEditor: true });
  }, "immediate")();
}

/**
 * Called with the write lock held. `afterProjectStop`: a pause of the project's editing put the run back in line.
 * `byEditor`: the editor's own Retry or Resume, which gives a pass's closing check its full allowance again.
 */
function resumeTask(ctx: Ctx, task: Task, opts: { choice?: RunChoice; afterProjectStop?: boolean; byEditor?: boolean }): Task {
  const { choice = {}, afterProjectStop = false, byEditor = false } = opts;
  const id = task.id;
  if (task.retryTaskId) return ctx.repos.tasks.get(task.retryTaskId)!;
  // The pass finished; only its closing check couldn't run. Retry runs that check again, as the same request, on the
  // video as it plays now, with its full allowance of returns. A pass recorded as failed for this before the pass was
  // kept as finished (2026-11-18) is picked up the same way, rather than starting the pass over.
  const checkOnly = closingCheckFailed(task) || (task.state === "failed" && !task.interrupted && isDialoguePass(task) && !!task.reply && !!task.repeatAudit);
  if (!afterProjectStop && checkOnly) {
    const head = ctx.repos.projects.get(task.projectId)?.head;
    if (!head) throw conflict("not_retryable", "This request cannot be retried.");
    const run = choice.agent ? { agent: choice.agent, model: choice.model, effort: choice.effort, fast: choice.fast, serviceTier: choice.serviceTier } : {};
    const queued = queueRepeatCheck(ctx, { ...task, ...run, repeatAudit: { ...task.repeatAudit!, returns: 0, totalReturns: 0, failed: undefined } }, head);
    ctx.log(`[task] ${id} closing check retried`);
    return queued;
  }
  const action = afterProjectStop ? "resume" : taskRecoveryAction(task, savedChanges(ctx, [task]).length > 0);
  if (!action) throw conflict("not_retryable", "This request cannot be retried.");
  const resumeRootId = action === "resume" ? task.resumeRootId ?? id : undefined;
  // A new id fences off late events, proposals and completions from the previous worker.
  const run = choice.agent ? { agent: choice.agent, model: choice.model, effort: choice.effort, fast: choice.fast, serviceTier: choice.serviceTier } : {};
  let retry = createTask(ctx, {
    ...task, ...run, state: "queued", instruction: recoveryInstruction(ctx, task, resumeRootId), resumeRootId,
    resumesAfterProjectStop: afterProjectStop || undefined, wordsRead: true,
    context: { ...task.context, threadId: task.context.threadId ?? id, message: task.context.message ?? task.instruction },
  });
  // The pass's closing words, and how far its closing check has got, go on with the run however it stopped: a quit
  // during the check lost the pass's words and started the check's count again. The editor's own Retry or Resume gives
  // the check its full allowance again, as Retry of a check that couldn't run does.
  const audit = task.repeatAudit && (byEditor ? { ...task.repeatAudit, returns: 0, totalReturns: 0, failed: undefined } : task.repeatAudit);
  // A request the editor started ahead of their calls was at work: it isn't put behind those calls again.
  if (task.startsBeforeCalls || audit || task.reply) {
    retry = saveTask(ctx, { ...retry, startsBeforeCalls: task.startsBeforeCalls, repeatAudit: audit, reply: task.reply });
  }
  const proposal = task.kind === "revise" && task.context.changeId && ctx.repos.changes.get(task.context.changeId);
  // The revision begins again on the proposal it names while that one stands. A pass a later revision has replaced stays
  // put away: marked as revising it would read as the pass this request revises, and its cut would be moved there
  // instead of in the pass that waits now (passToRevise).
  if (proposal && proposal.projectId === task.projectId && proposal.state !== "approved" && proposal.state !== "revising" && !proposal.replacedBy) {
    const change = ctx.repos.changes.put({ ...beginRevision(proposal, retry), updatedAt: now() });
    ctx.bus.publish({ type: "change.updated", projectId: change.projectId, change });
  }
  // A run its host cut short, or one a pause of the project's editing put back in line, kept its CLI session, so the
  // next attempt on the same model carries on in it instead of starting cold: started afresh, a pass spent 120 more
  // turns and 13.7M tokens finding its place again. On another model it starts a session of its own, and a run the
  // editor stopped ends its session with it. The host keeps the session's files for the attempt that carries on.
  const sameModel = retry.agent === task.agent && retry.model === task.model;
  const carriesOn = action === "resume" && (afterProjectStop || !!task.interrupted) && !!task.session && RESUMABLE.has(task.agent) && sameModel;
  const prior = { ...task, retryTaskId: retry.id, ...(carriesOn && { sessionCarriesOn: true }) };
  if (afterProjectStop) cancelTask(ctx, prior);
  else saveTask(ctx, prior);
  ctx.log(`[task] ${id} ${action === "resume" ? "resumed" : "retried"} as ${retry.id}${carriesOn ? " in its CLI session" : ""}`);
  if (carriesOn) {
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
    if (!pending.length) return resumeTask(ctx, task, { byEditor: true });
    // A transcription cut short by a quit or a pause starts again when Scarlet or the project's media is back, so the run keeps waiting for it.
    const restarts = (id: string) => {
      const last = latestTranscription(ctx, task.projectId, id);
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
    if (event.type !== "task.updated" || event.task.kind !== "transcribe" || !FINISHED_TASK.has(event.task.state)) return;
    try {
      continueReadyRuns(ctx, event.projectId);
    } catch (err) {
      ctx.log(`[task] couldn’t check runs waiting for transcripts: ${(err as Error).message}`);
    }
  });
}
