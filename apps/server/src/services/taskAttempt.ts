import { taskDialogueOperation, type Task, ATTEMPT_HEADER, TASK_HEADER, type TaskAttempt } from "@scarlet/shared";
import type { Ctx } from "../context.js";
import { badRequest, conflict, forbidden } from "../errors.js";

export function requestAttempt(request: Request): TaskAttempt | undefined {
  const taskId = request.headers.get(TASK_HEADER);
  const startedAt = request.headers.get(ATTEMPT_HEADER);
  return taskId === null && startedAt === null ? undefined : { taskId: taskId ?? "", startedAt: startedAt ?? undefined };
}

/** Check inside the transaction that publishes the write. A requeued task retains its previous start until reclaimed. */
export function requireActiveAttempt(ctx: Ctx, attempt: TaskAttempt | undefined, projectId: string, taskId?: string) {
  if (!attempt && !taskId) return;
  const task = ctx.repos.tasks.get(taskId ?? attempt!.taskId);
  if (!task || task.projectId !== projectId) throw badRequest("invalid_task", "Task must belong to this project.");
  if (!attempt?.startedAt || task.id !== attempt.taskId ||
      task.startedAt !== attempt.startedAt || (task.state !== "claimed" && task.state !== "running")) {
    throw conflict("inactive_task_attempt", "This run is no longer active. Continue from the editor's current request.");
  }
  return task;
}

/** A skill authoring or learning task may write through its own skill route only. */
export function requireProjectEditAttempt(ctx: Ctx, attempt: TaskAttempt | undefined, projectId: string, taskId?: string) {
  const task = requireActiveAttempt(ctx, attempt, projectId, taskId);
  if (task?.kind === "skill_from_change" || task?.kind === "skill_edit" || task?.kind === "learning_check") {
    throw forbidden("This task works on skills and cannot change the project.");
  }
  return task;
}

/** Local pause work can prepare source measurements and address the notes that requested it. */
export function requireLocalPauseTarget(task: Task | undefined, noteId?: string) {
  if (task && taskDialogueOperation(task) === "local-pauses" && !(noteId && task.context.noteIds?.includes(noteId)))
    throw badRequest("local_pauses", "This request only tightens local pauses.");
}
