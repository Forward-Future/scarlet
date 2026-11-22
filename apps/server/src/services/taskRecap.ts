import { toolAnnotations } from "@scarlet/mcp/annotations";
import { DialogueScanPage, planText, taskPlan, type Task } from "@scarlet/shared";
import { mergeRanges, type Change, type TimeRange } from "@scarlet/timeline";
import type { Ctx } from "../context.js";
import { prepareCutReview } from "./changes.js";
import { runAttempts } from "./runAttempts.js";
import { hasTranscript } from "./tasks.js";

/** The change row can be durable even if its id hasn't yet been copied onto the task. */
export function savedChanges(ctx: Ctx, tasks: Task[]) {
  return ctx.repos.changes.select(`project_id = ? AND
    (json_extract(json, '$.taskId') IN (SELECT value FROM json_each(?)) OR id IN (SELECT value FROM json_each(?)))`,
    [tasks[0]!.projectId, JSON.stringify(tasks.map(t => t.id)), JSON.stringify(tasks.flatMap(t => t.changeIds))], "created_at, rowid");
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

/** Structured recap of work already done across `attempts` (progress notes, plan, scanned ranges, refused saves, saved changes). */
function workRecapLines(ctx: Ctx, attempts: Task[], planTask: Task, events: ReturnType<Ctx["repos"]["taskEvents"]["list"]>): string[] {
  const lines: string[] = [];
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
  const plan = taskPlan(ctx.repos.taskEvents.list(planTask.id, "lastPlanOrAnswer"));
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
  return lines;
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
  lines.push(...workRecapLines(ctx, attempts, task, events));
  return lines.join("\n");
}

/**
 * What a fresh session (e.g. after switching models on an answer, or on a non-resumable CLI) is told of work already
 * done on `task` (and any earlier attempts under `task.resumeRootId`) before the editor's answer. `task`'s own Q&A is
 * omitted here because `buildSystemPrompt` renders it in the system prompt's `qa` section.
 */
export function answerHandoffInstruction(ctx: Ctx, task: Task): string {
  const run = task.resumeRootId && runAttempts(task.projectId, task.resumeRootId);
  const attempts = run ? ctx.repos.tasks.select(run.where, run.params, "created_at, rowid") : [task];
  const events = attempts.flatMap(t => ctx.repos.taskEvents.list(t.id, "conversation"));
  const priorQa = attempts
    .filter(t => t.id !== task.id)
    .flatMap(t => ctx.repos.taskEvents.list(t.id, "questionsAndAnswers"));
  const work = workRecapLines(ctx, attempts, task, events);
  if (!work.length && !priorQa.length && !task.resumeRootId) return task.instruction;
  const lines = [attempts[0]!.instruction];
  for (const ev of priorQa) {
    if (ev.type === "question") lines.push(`Agent asked: ${ev.text}`);
    if (ev.type === "answer") lines.push(`Editor answered: ${ev.text}`);
  }
  if (work.length) {
    lines.push("", "Continue this request after the editor’s answer. Continue only the unfinished work: the saved changes below and their states say what is done. Keep saved proposals and honor the editor’s decisions, including rejected or partially approved edits.");
    lines.push(...work);
  }
  return lines.join("\n");
}
